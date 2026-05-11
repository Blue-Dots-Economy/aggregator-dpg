/**
 * Keycloak ↔ Postgres drift reconciliation.
 *
 * Keycloak is the authoritative source for three pieces of identity data:
 *
 *   - `phoneNumber`     attribute
 *   - built-in `email`
 *   - `decision_made`   attribute   (approval gate)
 *
 * Postgres mirrors all three on `aggregators` (`contact.phone`,
 * `contact.email`, derived `status`). Drift sneaks in when:
 *
 *   - an admin edits a KC user directly via the KC admin console
 *   - an API write succeeds in KC but the follow-up DB write fails (e.g.
 *     the approval flow flips KC decision_made but the DB UPDATE errors)
 *   - a manual SQL fix-up forgets to mirror back to KC
 *
 * This job pages through every KC user that carries an `aggregator_id`
 * attribute, compares the three fields to the DB row, and repairs the DB
 * to match Keycloak. Discrepancies are emitted as structured warn logs
 * (`event: drift_repair`) so an alert can scrape them.
 *
 * Scheduled by `main.ts` as a BullMQ repeatable job. Cron cadence is
 * configured via `KEYCLOAK_SYNC_CRON` (default: every 15 minutes).
 */

import { eq } from 'drizzle-orm';
import { schema, getDb } from '../db.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

interface KcUserSummary {
  id: string;
  email?: string;
  enabled?: boolean;
  attributes?: Record<string, string[]>;
}

export interface KeycloakSyncOutcome {
  scanned: number;
  repaired: number;
  failed: number;
}

const PAGE_SIZE = 50;

export async function runKeycloakSync(): Promise<KeycloakSyncOutcome> {
  const log = logger.child({ operation: 'keycloak.drift_sync' });
  const start = Date.now();

  const token = await fetchAdminToken();
  if (!token.ok || !token.value) {
    log.error(
      { status: 'failure', sub: 'token', error: token.error },
      'unable to obtain KC admin token',
    );
    return { scanned: 0, repaired: 0, failed: 0 };
  }
  const adminToken = token.value;

  let scanned = 0;
  let repaired = 0;
  let failed = 0;

  for (let first = 0; ; first += PAGE_SIZE) {
    const page = await listUsers(adminToken, first, PAGE_SIZE);
    if (!page.ok || !page.value) {
      log.error(
        { status: 'failure', sub: 'list', error: page.error, first },
        'KC user listing failed',
      );
      failed += 1;
      break;
    }
    if (page.value.length === 0) break;

    for (const u of page.value) {
      scanned += 1;
      const aggregatorId = u.attributes?.['aggregator_id']?.[0];
      if (!aggregatorId) continue;

      const result = await reconcile(aggregatorId, u, log);
      if (result === 'repaired') repaired += 1;
      else if (result === 'failed') failed += 1;
    }
  }

  log.info(
    {
      status: 'success',
      event_type: 'audit',
      audit: 'keycloak.drift_sync',
      latency_ms: Date.now() - start,
      scanned,
      repaired,
      failed,
    },
    'drift sync completed',
  );
  return { scanned, repaired, failed };
}

async function reconcile(
  aggregatorId: string,
  kc: KcUserSummary,
  log: typeof logger,
): Promise<'noop' | 'repaired' | 'failed'> {
  const rows = await getDb()
    .select()
    .from(schema.aggregators)
    .where(eq(schema.aggregators.id, aggregatorId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    log.warn(
      {
        event: 'drift_repair',
        sub: 'orphan_kc_user',
        aggregator_id: aggregatorId,
        kc_user_id: kc.id,
      },
      'KC user references unknown aggregator',
    );
    return 'noop';
  }

  const kcPhone = kc.attributes?.['phoneNumber']?.[0] ?? null;
  const kcEmail = kc.email?.toLowerCase() ?? null;
  const kcDecision = kc.attributes?.['decision_made']?.[0];

  const dbPhone = row.contact.phone;
  const dbEmail = row.contact.email.toLowerCase();
  const dbDecision = statusToDecision(row.status);

  const phoneDrift = kcPhone !== null && kcPhone !== dbPhone;
  const emailDrift = kcEmail !== null && kcEmail !== dbEmail;
  const decisionDrift = kcDecision !== undefined && kcDecision !== dbDecision;

  if (!phoneDrift && !emailDrift && !decisionDrift) return 'noop';

  const patch: Partial<typeof row> & { updatedAt: Date } = { updatedAt: new Date() };
  if (phoneDrift || emailDrift) {
    patch.contact = {
      ...row.contact,
      ...(phoneDrift && kcPhone ? { phone: kcPhone } : {}),
      ...(emailDrift && kcEmail ? { email: kcEmail } : {}),
    };
  }
  if (decisionDrift && kcDecision) {
    patch.status = decisionToStatus(kcDecision);
  }
  patch.updatedBy = 'keycloak-sync';

  try {
    await getDb()
      .update(schema.aggregators)
      .set(patch)
      .where(eq(schema.aggregators.id, aggregatorId));
    log.warn(
      {
        event: 'drift_repair',
        aggregator_id: aggregatorId,
        kc_user_id: kc.id,
        phone_drift: phoneDrift,
        email_drift: emailDrift,
        decision_drift: decisionDrift,
      },
      'DB row updated to match Keycloak',
    );
    return 'repaired';
  } catch (err) {
    log.error(
      {
        event: 'drift_repair',
        status: 'failure',
        aggregator_id: aggregatorId,
        kc_user_id: kc.id,
        error: (err as Error).message,
      },
      'failed to apply drift repair',
    );
    return 'failed';
  }
}

function statusToDecision(status: string): 'pending' | 'approved' | 'rejected' {
  switch (status) {
    case 'active':
    case 'retired':
      return 'approved';
    case 'inactive':
      return 'rejected';
    default:
      return 'pending';
  }
}

function decisionToStatus(decision: string): 'pending' | 'active' | 'inactive' {
  switch (decision) {
    case 'approved':
      return 'active';
    case 'rejected':
      return 'inactive';
    default:
      return 'pending';
  }
}

// ─── Minimal KC admin client (HTTP only) ────────────────────────────────────

interface OkErr<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

async function fetchAdminToken(): Promise<OkErr<string>> {
  const base = config.KEYCLOAK_URL?.replace(/\/+$/, '');
  const realm = config.KEYCLOAK_REALM;
  const clientId = config.KEYCLOAK_CLIENT_ID;
  const clientSecret = config.KEYCLOAK_CLIENT_SECRET;
  if (!base || !realm || !clientId || !clientSecret) {
    return { ok: false, error: 'KEYCLOAK_* env vars not configured' };
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(`${base}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return { ok: false, error: `token HTTP ${res.status}` };
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) return { ok: false, error: 'no access_token in response' };
  return { ok: true, value: json.access_token };
}

async function listUsers(
  token: string,
  first: number,
  max: number,
): Promise<OkErr<KcUserSummary[]>> {
  const base = config.KEYCLOAK_URL?.replace(/\/+$/, '');
  const realm = config.KEYCLOAK_REALM;
  if (!base || !realm) return { ok: false, error: 'KEYCLOAK_* env vars not configured' };
  const url = `${base}/admin/realms/${realm}/users?first=${first}&max=${max}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { ok: false, error: `list HTTP ${res.status}` };
  const json = (await res.json()) as KcUserSummary[];
  return { ok: true, value: json };
}
