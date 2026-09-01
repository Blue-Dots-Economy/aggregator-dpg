/**
 * Coordinator-invite mint endpoint (#700 mint, #701 recovery folded in).
 *
 * Flag-gated by `ORG_HIERARCHY_ENABLED`: not registered when the flag is off.
 *
 *   POST /admin/v1/invites   body { grant, recipients[] }
 *     Authed by the owner GRANT token (the owner cannot log in). Three outcomes,
 *     all keyed off the grant:
 *       - valid grant  → mint one 14-day invite per recipient (refreshing an
 *         already-pending address), email each, return
 *         { recovered:false, sent, resent, invalid[] }. Per-org rate limited —
 *         the mandatory mitigation against a leaked grant (§7.2).
 *       - EXPIRED grant (signature valid) → mint NOTHING; re-mail a fresh grant
 *         to the org's REGISTERED owner address (never a request-supplied one),
 *         return { recovered:true, sent:0, resent:0, invalid:[] }. This folds
 *         the old /grant/renew recovery into the one endpoint.
 *       - invalid grant → GRANT_INVALID.
 *
 * Mint logic lives here, not in a page handler, so a future console is a second
 * caller rather than a rewrite (§4.3). Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { config, orgHierarchyEnabled } from '../config.js';
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
import { getRegistrationInvitesStore } from '../services/registration-invites-store/index.js';
import { mintInviteToken } from '../services/invite-token.js';
import { mintGrantToken, verifyGrantToken } from '../services/grant-token.js';
import { checkInviteMintRate } from '../services/invite-mint-rate.js';
import { formatApprovalTtl } from '../services/approval-token.js';
import { getMailer } from '@aggregator-dpg/mailer';
import {
  renderCoordinatorInvite,
  renderOrgOwnerApproved,
} from '../services/email-templates/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

const RecipientSchema = z.object({
  email: z.string().min(3),
  name: z.string().optional(),
});

const MintBodySchema = z.object({
  grant: z.string().min(1),
  recipients: z.array(RecipientSchema).min(1).max(500),
});

const MintResponseSchema = z.object({
  /** True when the grant was expired and a fresh grant link was re-mailed (nothing minted). */
  recovered: z.boolean(),
  sent: z.number().int(),
  resent: z.number().int(),
  invalid: z.array(z.object({ email: z.string(), reason: z.string() })),
});

// Conservative RFC-5322-lite check; the real gate is deliverability (a bad
// address simply never registers). Prevents obvious garbage lines from the
// bulk textarea becoming invite rows. Domain labels are `[^\s@.]+` separated by
// dots so the pattern is unambiguous (linear — no catastrophic backtracking).
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Builds the coordinator registration URL carrying an invite token. */
function inviteUrl(token: string): string {
  return `${config.PUBLIC_PORTAL_URL}/register/coordinator?invite=${encodeURIComponent(token)}`;
}

/** Builds the owner invite-management URL carrying a grant token. */
function grantUrl(token: string): string {
  return `${config.PUBLIC_PORTAL_URL}/register/invite?grant=${encodeURIComponent(token)}`;
}

/** One recipient outcome after resolving its invite row. */
interface ResolvedInvite {
  jti: string;
  refreshed: boolean;
}

/**
 * Resolves the invite row for one (org, email): refreshes an existing pending
 * invite, else creates a new one (falling back to refresh on a partial-unique
 * race). Returns the `jti` + whether it was a refresh, or `null` on a store error.
 *
 * @param invites - The invites store.
 * @param orgId - Parent org id.
 * @param email - Normalised recipient email.
 * @param expiresAt - New expiry to stamp.
 * @param createdBy - Minting subject for audit.
 * @returns The resolved invite, or `null` when the store failed.
 */
async function resolveInviteJti(
  invites: ReturnType<typeof getRegistrationInvitesStore>,
  orgId: string,
  email: string,
  expiresAt: Date,
  createdBy: string,
): Promise<ResolvedInvite | null> {
  const existing = await invites.findPendingByOrgAndEmail(orgId, email);
  if (!existing.ok) return null;
  if (existing.value) {
    const refreshed = await invites.refresh(existing.value.jti, { expiresAt, createdBy });
    return refreshed.ok ? { jti: refreshed.value.jti, refreshed: true } : null;
  }
  const created = await invites.create({ parentOrgId: orgId, email, expiresAt, createdBy });
  if (created.ok) return { jti: created.value.jti, refreshed: false };
  if (created.error.code === 'DUPLICATE_PENDING') {
    const again = await invites.findPendingByOrgAndEmail(orgId, email);
    if (again.ok && again.value) {
      const refreshed = await invites.refresh(again.value.jti, { expiresAt, createdBy });
      return refreshed.ok ? { jti: refreshed.value.jti, refreshed: true } : null;
    }
  }
  return null;
}

/** Result of minting a batch of recipients. */
interface MintSummary {
  sent: number;
  resent: number;
  invalid: Array<{ email: string; reason: string }>;
}

/** Inputs for {@link mintBatch}. */
interface MintBatchDeps {
  invites: ReturnType<typeof getRegistrationInvitesStore>;
  mailer: ReturnType<typeof getMailer>;
  orgId: string;
  orgName: string;
  recipients: z.infer<typeof MintBodySchema>['recipients'];
  ttlSec: number;
  expiresInText: string;
  createdBy: string;
  log: FastifyBaseLogger;
}

/**
 * Mints/refreshes and emails an invite per recipient, bucketing invalid and
 * duplicate-in-batch addresses. A failed email is logged and still counted as
 * sent (the row exists; the owner can re-invite to retry delivery).
 *
 * @param deps - Store, mailer, org, recipients, and token settings.
 * @returns Per-batch counts + the invalid list.
 */
async function mintBatch(deps: MintBatchDeps): Promise<MintSummary> {
  const { invites, mailer, orgId, orgName, recipients, ttlSec, expiresInText, createdBy, log } =
    deps;
  let sent = 0;
  let resent = 0;
  const invalid: MintSummary['invalid'] = [];
  // De-dupe within the batch so one address can't consume two slots / two emails.
  const seen = new Set<string>();

  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      invalid.push({ email: recipient.email, reason: 'invalid_email' });
      continue;
    }
    if (seen.has(email)) {
      invalid.push({ email: recipient.email, reason: 'duplicate_in_batch' });
      continue;
    }
    seen.add(email);

    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    const resolved = await resolveInviteJti(invites, orgId, email, expiresAt, createdBy);
    if (!resolved) {
      invalid.push({ email: recipient.email, reason: 'store_error' });
      continue;
    }

    const { token } = await mintInviteToken({ jti: resolved.jti, org: orgId, email });
    const mail = renderCoordinatorInvite({
      orgName,
      inviteUrl: inviteUrl(token),
      expiresInText,
      ...(recipient.name ? { recipientName: recipient.name } : {}),
    });
    const send = await mailer.send({
      to: email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    if (!send.ok) {
      log.warn(
        {
          status: 'failure',
          sub_operation: 'mailer.send.coordinatorInvite',
          code: send.error.code,
        },
        'coordinator-invite email delivery failed (invite minted)',
      );
    }
    if (resolved.refreshed) resent += 1;
    else sent += 1;
  }
  return { sent, resent, invalid };
}

/**
 * Registers the invite mint route. No-op when the org hierarchy is disabled.
 *
 * @param app - Fastify instance to attach the route to.
 */
export async function registerInviteRoutes(app: FastifyInstance): Promise<void> {
  if (!orgHierarchyEnabled()) return;

  app.post(
    '/admin/v1/invites',
    {
      schema: {
        tags: ['invites'],
        summary: 'Mint coordinator invites (owner grant-authed)',
        description:
          'Authed by the owner grant token. A valid grant mints/refreshes one 14-day invite per recipient and emails each. An expired grant mints nothing and re-mails a fresh grant to the registered owner (recovery). Per-org rate limited. Only registered when ORG_HIERARCHY_ENABLED=true.',
        body: MintBodySchema,
        response: { 200: MintResponseSchema, ...errorResponses(400, 409, 429, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'invites.mint' });
      const body = req.body as z.infer<typeof MintBodySchema>;

      // Accept an expired-but-signature-valid grant so recovery can run here; a
      // bad signature / wrong audience still fails as GRANT_INVALID.
      const grant = await verifyGrantToken(body.grant, { allowExpired: true });
      if (!grant.ok) {
        throw httpError('GRANT_INVALID');
      }
      const orgId = grant.org;

      const orgStore = getAggregatorOrgStore();
      const org = await orgStore.findById(orgId);
      if (!org.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(org.error.message),
          fields: { sub_operation: 'orgStore.findById' },
        });
      }
      // Grant is implicitly revoked once the org leaves active (§5.2). Bind to a
      // local so TS narrows it non-null for the rest of the handler.
      const orgRow = org.value;
      if (!orgRow || orgRow.status !== 'active') {
        throw httpError('TARGET_ORG_INACTIVE');
      }

      // Expired grant → recovery: re-mail a fresh grant to the REGISTERED owner
      // address (never a request input), mint nothing.
      if (grant.expired) {
        const fresh = await mintGrantToken({ org: orgId, ttlSec: config.GRANT_TOKEN_TTL_SECONDS });
        const mail = renderOrgOwnerApproved({
          orgName: orgRow.displayName,
          ownerEmail: orgRow.ownerEmail,
          inviteUrl: grantUrl(fresh.token),
        });
        const send = await getMailer().send({
          to: orgRow.ownerEmail,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
        if (!send.ok) {
          log.warn(
            {
              status: 'failure',
              sub_operation: 'mailer.send.grantRecovery',
              code: send.error.code,
            },
            'fresh-grant email delivery failed',
          );
        }
        log.info(
          { status: 'success', org_id: orgId, recovered: true },
          'expired grant — fresh link re-mailed',
        );
        return reply.status(200).send({ recovered: true, sent: 0, resent: 0, invalid: [] });
      }

      // Rate limit the whole batch against the per-org window (§7.2).
      const rl = await checkInviteMintRate(orgId, body.recipients.length);
      if (!rl.allowed) {
        void reply.header('Retry-After', String(rl.retryAfterSeconds));
        throw httpError('RATE_LIMITED', {
          detail: `Retry in ${rl.retryAfterSeconds}s.`,
          fields: { retry_after_seconds: rl.retryAfterSeconds },
        });
      }

      const summary = await mintBatch({
        invites: getRegistrationInvitesStore(),
        mailer: getMailer(),
        orgId,
        orgName: orgRow.displayName,
        recipients: body.recipients,
        ttlSec: config.INVITE_TOKEN_TTL_SECONDS,
        expiresInText: formatApprovalTtl(config.INVITE_TOKEN_TTL_SECONDS),
        createdBy: `grant:${orgId}`,
        log,
      });
      log.info(
        { status: 'success', org_id: orgId, ...summary, invalid: summary.invalid.length },
        'invites minted',
      );
      return reply.status(200).send({ recovered: false, ...summary });
    },
  );
}
