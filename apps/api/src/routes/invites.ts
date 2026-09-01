/**
 * Coordinator-invite mint + grant-recovery endpoints (#700 mint, #701 recovery).
 *
 * Flag-gated by `ORG_HIERARCHY_ENABLED`: not registered when the flag is off.
 *
 *   POST /admin/v1/invites            body { grant, recipients[] }
 *     Authed by the owner GRANT token (the owner cannot log in). Mints one
 *     14-day invite per recipient (refreshing an already-pending address),
 *     emails each, and returns { sent, resent, invalid[] }. Per-org rate
 *     limited — the mandatory mitigation against a leaked grant (§7.2).
 *
 *   POST /admin/v1/invites/grant/renew   body { grant }
 *     Recovery for an expired-but-signature-valid grant. Mints a fresh grant
 *     and emails it to the org's REGISTERED owner address (never a
 *     request-supplied one), so recovery is not a mail-redirection primitive.
 *
 * Mint logic lives here, not in a page handler, so a future console is a second
 * caller rather than a rewrite (§4.3). Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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

const RenewBodySchema = z.object({ grant: z.string().min(1) });

const MintResponseSchema = z.object({
  sent: z.number().int(),
  resent: z.number().int(),
  invalid: z.array(z.object({ email: z.string(), reason: z.string() })),
});

// Conservative RFC-5322-lite check; the real gate is deliverability (a bad
// address simply never registers). Prevents obvious garbage lines from the
// bulk textarea becoming invite rows.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Builds the coordinator registration URL carrying an invite token. */
function inviteUrl(token: string): string {
  return `${config.PUBLIC_PORTAL_URL}/register/coordinator?invite=${encodeURIComponent(token)}`;
}

/** Builds the owner invite-management URL carrying a grant token. */
function grantUrl(token: string): string {
  return `${config.PUBLIC_PORTAL_URL}/register/invite?grant=${encodeURIComponent(token)}`;
}

/**
 * Registers the invite mint + grant-recovery routes. No-op when the org
 * hierarchy is disabled.
 *
 * @param app - Fastify instance to attach the routes to.
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
          'Authed by the owner grant token. Mints/refreshes one 14-day invite per recipient, emails each, and returns a per-recipient summary. Per-org rate limited. Only registered when ORG_HIERARCHY_ENABLED=true.',
        body: MintBodySchema,
        response: { 200: MintResponseSchema, ...errorResponses(400, 409, 410, 429, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'invites.mint' });
      const body = req.body as z.infer<typeof MintBodySchema>;

      const grant = await verifyGrantToken(body.grant);
      if (!grant.ok) {
        throw httpError(grant.error.code === 'EXPIRED' ? 'GRANT_EXPIRED' : 'GRANT_INVALID');
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
      // Grant is implicitly revoked once the org leaves active (§5.2).
      if (!org.value || org.value.status !== 'active') {
        throw httpError('TARGET_ORG_INACTIVE');
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

      const invites = getRegistrationInvitesStore();
      const mailer = getMailer();
      const ttlSec = config.INVITE_TOKEN_TTL_SECONDS;
      const expiresInText = formatApprovalTtl(ttlSec);
      const createdBy = `grant:${orgId}`;

      let sent = 0;
      let resent = 0;
      const invalid: Array<{ email: string; reason: string }> = [];
      // De-dupe within the batch so one address can't consume two slots / two
      // emails from a single paste.
      const seen = new Set<string>();

      for (const recipient of body.recipients) {
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
        // Existing pending invite for this address → refresh (re-invite),
        // otherwise create. A create race on the partial-unique index falls
        // back to refresh so a concurrent paste can't error.
        const existing = await invites.findPendingByOrgAndEmail(orgId, email);
        if (!existing.ok) {
          invalid.push({ email: recipient.email, reason: 'store_error' });
          continue;
        }
        let jti: string | null = null;
        let wasRefresh = false;
        if (existing.value) {
          const refreshed = await invites.refresh(existing.value.jti, { expiresAt, createdBy });
          if (refreshed.ok) {
            jti = refreshed.value.jti;
            wasRefresh = true;
          }
        } else {
          const created = await invites.create({ parentOrgId: orgId, email, expiresAt, createdBy });
          if (created.ok) {
            jti = created.value.jti;
          } else if (created.error.code === 'DUPLICATE_PENDING') {
            const again = await invites.findPendingByOrgAndEmail(orgId, email);
            if (again.ok && again.value) {
              const refreshed = await invites.refresh(again.value.jti, { expiresAt, createdBy });
              if (refreshed.ok) {
                jti = refreshed.value.jti;
                wasRefresh = true;
              }
            }
          }
        }
        if (!jti) {
          invalid.push({ email: recipient.email, reason: 'store_error' });
          continue;
        }

        const { token } = await mintInviteToken({ jti, org: orgId, email });
        const mail = renderCoordinatorInvite({
          orgName: org.value.displayName,
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
          // The invite row exists; only delivery failed. Log and count it as
          // sent — the owner can re-invite to retry delivery.
          log.warn(
            {
              status: 'failure',
              sub_operation: 'mailer.send.coordinatorInvite',
              code: send.error.code,
            },
            'coordinator-invite email delivery failed (invite minted)',
          );
        }
        if (wasRefresh) resent += 1;
        else sent += 1;
      }

      log.info(
        { status: 'success', org_id: orgId, sent, resent, invalid: invalid.length },
        'invites minted',
      );
      return reply.status(200).send({ sent, resent, invalid });
    },
  );

  app.post(
    '/admin/v1/invites/grant/renew',
    {
      schema: {
        tags: ['invites'],
        summary: 'Email a fresh owner grant link (expired-grant recovery)',
        description:
          "Accepts an expired-but-signature-valid grant, mints a fresh one, and emails it to the org's REGISTERED owner address (never a request-supplied one). Only registered when ORG_HIERARCHY_ENABLED=true.",
        body: RenewBodySchema,
        response: { 200: z.object({ ok: z.literal(true) }), ...errorResponses(400, 409, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'invites.grantRenew' });
      const body = req.body as z.infer<typeof RenewBodySchema>;

      // Accept expired grants here — that's the whole point of recovery — but a
      // bad signature / wrong audience still fails.
      const grant = await verifyGrantToken(body.grant, { allowExpired: true });
      if (!grant.ok) {
        throw httpError('GRANT_INVALID');
      }
      const orgStore = getAggregatorOrgStore();
      const org = await orgStore.findById(grant.org);
      if (!org.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(org.error.message),
          fields: { sub_operation: 'orgStore.findById' },
        });
      }
      if (!org.value || org.value.status !== 'active') {
        throw httpError('TARGET_ORG_INACTIVE');
      }

      const { token } = await mintGrantToken({
        org: grant.org,
        ttlSec: config.GRANT_TOKEN_TTL_SECONDS,
      });
      const mail = renderOrgOwnerApproved({
        orgName: org.value.displayName,
        ownerEmail: org.value.ownerEmail,
        inviteUrl: grantUrl(token),
      });
      // Emailed to the REGISTERED owner address on file, not any request input.
      const send = await getMailer().send({
        to: org.value.ownerEmail,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
      if (!send.ok) {
        log.warn(
          { status: 'failure', sub_operation: 'mailer.send.grantRenew', code: send.error.code },
          'fresh-grant email delivery failed',
        );
      }
      log.info({ status: 'success', org_id: grant.org }, 'fresh grant emailed to registered owner');
      return reply.status(200).send({ ok: true });
    },
  );
}
