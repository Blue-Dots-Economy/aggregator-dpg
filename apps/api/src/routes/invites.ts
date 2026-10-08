/**
 * Coordinator-invite mint endpoint (#700 mint, #701 recovery folded in).
 *
 * Always registered (the org hierarchy is always on since migration 0028).
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
 * Mint logic lives in `services/invites/mint.ts`, shared with the console's
 * `POST /v1/user/create` (Phase 5). Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
import { getRegistrationInvitesStore } from '../services/registration-invites-store/index.js';
import { mintInviteBatch } from '../services/invites/mint.js';
import { verifyGrantToken } from '../services/grant-token.js';
import { ownerSignInUrl } from '../services/decisions/org.js';
import { checkInviteMintRate, checkInviteIpRate } from '../services/invite-mint-rate.js';
import { getMailer } from '@aggregator-dpg/mailer';
import { renderOwnerGrantRefreshed } from '../services/email-templates/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

const RecipientSchema = z.object({
  email: z.string().min(3),
  name: z.string().optional(),
});

const MintBodySchema = z.object({
  grant: z.string().min(1),
  // Per-request recipient cap — configurable (INVITE_MINT_MAX_RECIPIENTS,
  // default 10). Keep it ≤ the per-org window max so one full batch fits the
  // rate window rather than tripping the limit.
  recipients: z.array(RecipientSchema).min(1).max(config.INVITE_MINT_MAX_RECIPIENTS),
});

const MintResponseSchema = z.object({
  /** True when the grant was expired and a sign-in link was mailed (nothing minted). */
  recovered: z.boolean(),
  sent: z.number().int(),
  resent: z.number().int(),
  invalid: z.array(z.object({ email: z.string(), reason: z.string() })),
  /** Addresses already coordinators of this org (nothing mailed). */
  existing: z.array(z.object({ email: z.string(), status: z.string() })),
});

/**
 * Registers the invite mint route.
 *
 * @param app - Fastify instance to attach the route to.
 */
export async function registerInviteRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/admin/v1/invites',
    {
      schema: {
        tags: ['invites'],
        summary: 'Mint coordinator invites (owner grant-authed)',
        description:
          'Authed by the owner grant token. A valid grant mints/refreshes one 14-day invite per recipient and emails each. An expired grant mints nothing and re-mails a fresh grant to the registered owner (recovery). Per-org rate limited.',
        body: MintBodySchema,
        response: { 200: MintResponseSchema, ...errorResponses(400, 409, 429, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'invites.mint' });
      const body = req.body as z.infer<typeof MintBodySchema>;

      // M4: per-IP throttle before the (cheap) grant verify — matches every
      // other public surface. Fail-open (a coarse DoS guard, not the anti-abuse
      // control; the per-org limit below is the fail-closed one).
      const ipRl = await checkInviteIpRate(req.ip);
      if (!ipRl.allowed) {
        void reply.header('Retry-After', String(ipRl.retryAfterSeconds));
        throw httpError('RATE_LIMITED', {
          detail: `Retry in ${ipRl.retryAfterSeconds}s.`,
          fields: { retry_after_seconds: ipRl.retryAfterSeconds },
        });
      }

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
      // The Default org has no owner console to invite from (0028).
      if (orgRow?.status !== 'active' || orgRow.isDefault) {
        throw httpError('TARGET_ORG_INACTIVE');
      }

      // H1: the per-org limit covers BOTH the recovery email and the mint batch,
      // so a leaked/expired grant can't loop the recovery path to send unbounded
      // mail. Recovery costs one slot (one email); a mint costs one per recipient.
      const cost = grant.expired ? 1 : body.recipients.length;
      const rl = await checkInviteMintRate(orgId, cost);
      if (!rl.allowed) {
        void reply.header('Retry-After', String(rl.retryAfterSeconds));
        throw httpError('RATE_LIMITED', {
          detail: `Retry in ${rl.retryAfterSeconds}s.`,
          fields: { retry_after_seconds: rl.retryAfterSeconds },
        });
      }

      // Expired grant → recovery: mail the REGISTERED owner address (never a
      // request input) a console sign-in link — no fresh grant (Phase 5: grants
      // are no longer minted; still-valid ones work until they expire).
      if (grant.expired) {
        const mail = renderOwnerGrantRefreshed({
          orgName: orgRow.displayName,
          inviteUrl: ownerSignInUrl(),
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
            'sign-in email delivery failed',
          );
        }
        log.info(
          { status: 'success', org_id: orgId, recovered: true },
          'expired grant — sign-in link mailed',
        );
        return reply
          .status(200)
          .send({ recovered: true, sent: 0, resent: 0, invalid: [], existing: [] });
      }

      const summary = await mintInviteBatch({
        invites: getRegistrationInvitesStore(),
        mailer: getMailer(),
        orgId,
        orgName: orgRow.displayName,
        inviterEmail: orgRow.ownerEmail,
        recipients: body.recipients,
        ttlSec: config.INVITE_TOKEN_TTL_SECONDS,
        createdBy: `grant:${orgId}`,
        log,
      });
      log.info(
        {
          status: 'success',
          org_id: orgId,
          sent: summary.sent,
          resent: summary.resent,
          invalid: summary.invalid.length,
          existing: summary.existing.length,
        },
        'invites minted',
      );
      return reply.status(200).send({ recovered: false, ...summary });
    },
  );
}
