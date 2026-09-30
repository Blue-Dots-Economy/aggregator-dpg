/**
 * One-off backfill of org-owner names onto the `contact` table.
 *
 * Belongs to `@aggregator-dpg/api` (user & org management refactor, Phase 1).
 * Before migration 0025 an org owner's name was never stored in the database —
 * it only reached Keycloak as first/last name — so contacts backfilled from
 * `aggregator_orgs` have `name IS NULL`. This reads the name back from Keycloak
 * via `aggregator_orgs.owner_kc_sub` and records it where the contact still has
 * none (an existing name always wins). Idempotent; safe to re-run.
 *
 * Runner: `apps/api/scripts/backfill-owner-contact-names.ts`.
 */

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { aggregatorOrgs, contact } from '../db/schema.js';
import { getDb } from '../db/client.js';
import { logger } from '../logger.js';
import type { IdpAdminAdapter, IdpUser, IdpResult } from './idp-admin/interface.js';

/** An org whose linked owner contact has no name yet. */
export interface OwnerNameCandidate {
  orgId: string;
  contactId: string;
  ownerKcSub: string;
}

/** Persistence seam — lets the backfill run against a fake in tests. */
export interface OwnerNameBackfillDeps {
  idp: IdpAdminAdapter;
  listCandidates: () => Promise<OwnerNameCandidate[]>;
  /** Sets the name only while the contact still has none; returns whether it did. */
  setNameIfMissing: (contactId: string, name: string) => Promise<boolean>;
  /** Delay before the single retry of a transient Keycloak failure. */
  retryDelayMs?: number;
}

/** Outcome counts — never names or emails. */
export interface OwnerNameBackfillReport {
  candidates: number;
  updated: number;
  /** Keycloak user has no first/last name. */
  noName: number;
  /** Keycloak user no longer exists. */
  userMissing: number;
  /** Keycloak unreachable after the retry. */
  failed: number;
  dryRun: boolean;
}

/**
 * Fills missing org-owner contact names from Keycloak.
 *
 * @param deps - Keycloak adapter plus the candidate/update seams.
 * @param opts - `dryRun` reports what would change without writing.
 * @returns Per-outcome counts.
 */
export async function backfillOwnerContactNames(
  deps: OwnerNameBackfillDeps,
  opts: { dryRun: boolean },
): Promise<OwnerNameBackfillReport> {
  const report: OwnerNameBackfillReport = {
    candidates: 0,
    updated: 0,
    noName: 0,
    userMissing: 0,
    failed: 0,
    dryRun: opts.dryRun,
  };
  const candidates = await deps.listCandidates();
  report.candidates = candidates.length;

  for (const c of candidates) {
    const start = Date.now();
    const user = await findWithRetry(deps.idp, c.ownerKcSub, deps.retryDelayMs ?? 500);
    if (!user.ok) {
      report.failed++;
      logger.error({
        operation: 'ownerNameBackfill.findUser',
        status: 'failure',
        error: user.error.message,
        error_type: user.error.code,
        latency_ms: Date.now() - start,
        org_id: c.orgId,
      });
      continue;
    }
    if (!user.value) {
      report.userMissing++;
      logger.warn({
        operation: 'ownerNameBackfill.findUser',
        status: 'skipped',
        reason: 'kc_user_missing',
        org_id: c.orgId,
      });
      continue;
    }
    const name = displayName(user.value);
    if (!name) {
      report.noName++;
      logger.info({
        operation: 'ownerNameBackfill',
        status: 'skipped',
        reason: 'kc_user_has_no_name',
        org_id: c.orgId,
      });
      continue;
    }
    if (opts.dryRun) {
      report.updated++;
      continue;
    }
    if (await deps.setNameIfMissing(c.contactId, name)) report.updated++;
    logger.info({
      operation: 'ownerNameBackfill.setName',
      status: 'success',
      latency_ms: Date.now() - start,
      org_id: c.orgId,
    });
  }
  return report;
}

/** First + last name joined, or `null` when Keycloak holds neither. */
function displayName(u: IdpUser): string | null {
  const name = [u.firstName, u.lastName]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join(' ');
  return name === '' ? null : name;
}

/** `findById` with one retry (after `delayMs`) on a transient Keycloak failure. */
async function findWithRetry(
  idp: IdpAdminAdapter,
  sub: string,
  delayMs: number,
): Promise<IdpResult<IdpUser | null>> {
  const first = await idp.findById(sub);
  if (first.ok || first.error.code !== 'IDP_UNAVAILABLE') return first;
  await new Promise((r) => setTimeout(r, delayMs));
  return idp.findById(sub);
}

/**
 * Candidate orgs from the live database: linked to a contact that has no name,
 * and carrying a Keycloak owner to read the name from.
 *
 * @returns The candidates (possibly empty).
 */
export async function listOwnerNameCandidatesFromDb(): Promise<OwnerNameCandidate[]> {
  const rows = await getDb()
    .select({
      orgId: aggregatorOrgs.id,
      contactId: aggregatorOrgs.contactId,
      ownerKcSub: aggregatorOrgs.ownerKcSub,
    })
    .from(aggregatorOrgs)
    .innerJoin(contact, eq(contact.id, aggregatorOrgs.contactId))
    .where(and(isNull(contact.name), isNotNull(aggregatorOrgs.ownerKcSub)));
  return rows.flatMap((r) =>
    r.contactId && r.ownerKcSub
      ? [{ orgId: r.orgId, contactId: r.contactId, ownerKcSub: r.ownerKcSub }]
      : [],
  );
}

/**
 * Sets `contact.name` only while it is still NULL (an existing name wins).
 *
 * @param contactId - The contact to name.
 * @param name - The name read from Keycloak.
 * @returns Whether a row was updated.
 */
export async function setContactNameIfMissingInDb(
  contactId: string,
  name: string,
): Promise<boolean> {
  const rows = await getDb()
    .update(contact)
    .set({ name })
    .where(and(eq(contact.id, contactId), isNull(contact.name)))
    .returning({ id: contact.id });
  return rows.length > 0;
}
