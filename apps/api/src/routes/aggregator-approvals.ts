/**
 * Admin approval endpoints.
 *
 * URL shape mirrors the spec under `4.3.2 Endpoints by Actor & Action`:
 *
 *   GET  /admin/v1/aggregator-registrations/read/:id?token=...&intent=approve|reject
 *     Renders an HTML confirmation page that tells the admin which action
 *     they're about to take. If `aggregators.status` is already terminal
 *     (`active` after approve / `inactive` after reject) — i.e. a previous
 *     click ran to completion — it instead renders an "already decided"
 *     page so duplicate clicks never resend emails.
 *
 *   POST /admin/v1/aggregator-registrations/decision/:id
 *     Body: { token, decision: 'approve' | 'reject', reason? }
 *     Verifies the JWT, re-checks `aggregators.status` (single-use guard),
 *     applies the action:
 *       approve → store.updateStatus(id, 'active') + idp.enableUser
 *                 + idp.setUserDecision(kcId, 'approved')
 *       reject  → store.updateStatus(id, 'inactive')
 *                 + idp.setUserDecision(kcId, 'rejected')
 *     Sends the applicant a notification email and returns a result page.
 *
 * Source of truth for the decision is the DB column `aggregators.status`.
 * Keycloak mirrors the decision via the `decision_made` user attribute so
 * the auth middleware can gate login at JWT-verify time without an extra
 * DB hit.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { verifyApprovalToken } from '../services/approval-token.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { getMailer } from '../services/mailer/index.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import {
  renderApplicantApproved,
  renderApplicantRejected,
} from '../services/email-templates/index.js';
import { renderConfirmPage, renderResultPage } from '../views/approval-pages.js';
import type { Aggregator } from '../services/aggregator-store/index.js';
import { KC_ATTR } from '../services/idp-admin/index.js';
import type { IdpUser } from '../services/idp-admin/index.js';

const DecisionBodySchema = z.object({
  token: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(2000).optional(),
});

export async function registerAggregatorApprovalRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/v1/aggregator-registrations/read/:id',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Querystring: { token?: string; intent?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const aggregatorId = req.params.id;
      const { token, intent } = req.query;

      if (!token) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Missing token',
            message: 'This link is missing the approval token.',
          }),
        );
      }

      const verified = await verifyApprovalToken(token);
      if (!verified.ok) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Invalid link',
            message: tokenErrorMessage(verified.error.code),
          }),
        );
      }
      if (verified.aggregatorId !== aggregatorId) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Invalid link',
            message: 'Token does not match the requested aggregator.',
          }),
        );
      }
      const effectiveIntent = isIntent(intent) ? intent : verified.intent;

      const lookup = await loadAggregatorAndUser(aggregatorId);
      if (!lookup.ok) return sendHtml(reply, lookup.status, lookup.html);

      const prior = decisionFromStatus(lookup.aggregator.status);
      if (prior) {
        return sendHtml(reply, 200, renderResultPage(alreadyDecidedView(prior)));
      }

      return sendHtml(
        reply,
        200,
        renderConfirmPage({
          aggregatorId,
          intent: effectiveIntent,
          token,
          applicantEmail: lookup.kcUser.email,
          association: lookup.aggregator.name,
          // For aggregator actors `type` is null. Surface `actor_type`
          // instead so the admin page always shows something meaningful.
          aggregatorType: lookup.aggregator.type ?? lookup.aggregator.actorType,
          postUrl: `${config.PUBLIC_API_URL}/admin/v1/aggregator-registrations/decision/${aggregatorId}`,
        }),
      );
    },
  );

  app.post(
    '/admin/v1/aggregator-registrations/decision/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const aggregatorId = req.params.id;
      const log = req.log.child({
        operation: 'aggregator-approval.decide',
        aggregator_id: aggregatorId,
      });
      const parsed = DecisionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Bad request',
            message: 'Invalid form submission.',
          }),
        );
      }

      const verified = await verifyApprovalToken(parsed.data.token);
      if (!verified.ok) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Invalid link',
            message: tokenErrorMessage(verified.error.code),
          }),
        );
      }
      if (verified.aggregatorId !== aggregatorId) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Invalid link',
            message: 'Token does not match the requested aggregator.',
          }),
        );
      }

      const lookup = await loadAggregatorAndUser(aggregatorId);
      if (!lookup.ok) return sendHtml(reply, lookup.status, lookup.html);

      // Single-use guard: DB status is the source of truth. Anything other
      // than `pending` means this aggregator has already been decided.
      const prior = decisionFromStatus(lookup.aggregator.status);
      if (prior) {
        return sendHtml(reply, 200, renderResultPage(alreadyDecidedView(prior)));
      }

      const store = getAggregatorStore();
      const idp = getIdpAdmin();
      const mailer = getMailer();

      if (parsed.data.decision === 'approve') {
        // 1. DB first — flip status. KC mirror follows.
        const dbUpdate = await store.updateStatus(aggregatorId, 'active', 'admin');
        if (!dbUpdate.ok) {
          log.error(
            {
              status: 'failure',
              sub_operation: 'store.updateStatus.active',
              code: dbUpdate.error.code,
              cause: dbUpdate.error.message,
            },
            'failed to flip aggregator status to active',
          );
          return sendHtml(
            reply,
            503,
            renderResultPage({
              status: 'error',
              title: 'Action failed',
              message: 'Database unavailable. Please try again shortly.',
            }),
          );
        }

        const enable = await idp.enableUser(lookup.kcUser.id);
        if (!enable.ok) {
          log.error(
            {
              status: 'failure',
              sub_operation: 'idp.enableUser',
              code: enable.error.code,
              cause: enable.error.message,
            },
            'failed to enable KC user during approval (DB already flipped active)',
          );
          // Don't roll back the DB — the drift-reconciliation worker will
          // notice the mismatch and re-enable the user on the next pass.
          return sendHtml(
            reply,
            503,
            renderResultPage({
              status: 'error',
              title: 'Action failed',
              message: 'Identity service unavailable. Please try again shortly.',
            }),
          );
        }

        const stamp = await idp.setUserDecision(lookup.kcUser.id, 'approved');
        if (!stamp.ok) {
          log.warn(
            {
              status: 'failure',
              sub_operation: 'idp.setUserDecision.approved',
              code: stamp.error.code,
              cause: stamp.error.message,
            },
            'failed to stamp decision_made=approved on KC user (auth-gate stays open via enabled flag)',
          );
        }

        // Register the aggregator with signalstack and stamp the returned
        // org_id on the KC user. Soft-fail: an outage here must not block
        // approval — the login-time fallback retries on the applicant's
        // next authenticated request because the upsert is idempotent on
        // external_id (our aggregatorId).
        const signalstack = getSignalStackWriter();
        if (signalstack) {
          const upsertStart = Date.now();
          const upsertResult = await signalstack.upsertAggregator({
            external_id: aggregatorId,
            name: lookup.aggregator.name,
            slug: lookup.aggregator.orgSlug,
            // Signalstack's dashboard endpoint fails with
            // NO_DOMAINS_CONFIGURED when the org's metadata.domains
            // is empty. Send the full domain list every approval so
            // the read endpoints work the moment the aggregator
            // signs in. Aggregator participant focus is enforced at
            // a different layer (KC `aggregator_type` claim).
            domains: ['seeker', 'provider'],
          });
          if (!upsertResult.success) {
            log.warn(
              {
                status: 'failure',
                sub_operation: 'signalstack.upsertAggregator',
                code: upsertResult.error.code,
                cause: upsertResult.error.message,
                latency_ms: Date.now() - upsertStart,
              },
              'signalstack aggregator upsert failed — login fallback will retry',
            );
          } else {
            const orgId = upsertResult.value.org_id;
            // Dual-write to KC attr + Postgres mirror. The worker and the
            // anonymous public-link submission path read the DB column
            // (they have no KC admin client); the access-token claim is
            // sourced from the KC attribute. Either write failure is
            // soft-fail — the login backfill repairs whichever leg lags.
            const [attrWrite, dbWrite] = await Promise.all([
              idp.setAttributes(lookup.kcUser.id, { signalstack_org_id: orgId }),
              store.updateSignalstackOrgId(aggregatorId, orgId, 'admin'),
            ]);
            if (!attrWrite.ok) {
              log.warn(
                {
                  status: 'failure',
                  sub_operation: 'idp.setAttributes.signalstack_org_id',
                  code: attrWrite.error.code,
                  cause: attrWrite.error.message,
                },
                'failed to stamp signalstack_org_id on KC user — login fallback will retry',
              );
            }
            if (!dbWrite.ok) {
              log.warn(
                {
                  status: 'failure',
                  sub_operation: 'store.updateSignalstackOrgId',
                  code: dbWrite.error.code,
                  cause: dbWrite.error.message,
                },
                'failed to persist signalstack_org_id on aggregators row — login fallback will retry',
              );
            }
            if (attrWrite.ok && dbWrite.ok) {
              log.info(
                {
                  status: 'success',
                  sub_operation: 'signalstack.upsertAggregator',
                  signalstack_org_id: orgId,
                  latency_ms: Date.now() - upsertStart,
                },
                'aggregator registered in signalstack',
              );
            }
          }
        }

        const approvedMail = renderApplicantApproved({
          contactName: applicantNameOf(lookup),
          association: lookup.aggregator.name,
          identifier: lookup.aggregator.contact.email,
          signInUrl: `${config.PUBLIC_PORTAL_URL}/login`,
        });
        const sendResult = await mailer.send({
          to: lookup.aggregator.contact.email,
          subject: approvedMail.subject,
          html: approvedMail.html,
          text: approvedMail.text,
        });
        if (!sendResult.ok) {
          log.error(
            {
              status: 'failure',
              sub_operation: 'mailer.send.approved',
              code: sendResult.error.code,
              cause: sendResult.error.message,
            },
            'approved-email delivery failed',
          );
        }
        log.info(
          { status: 'success', decision: 'approve', new_status: 'active' },
          'aggregator approved',
        );
        return sendHtml(
          reply,
          200,
          renderResultPage({
            status: 'success',
            title: 'Application approved',
            message: `${lookup.aggregator.contact.email} can now sign in to the portal.`,
          }),
        );
      }

      // Reject path — DB status → 'inactive', KC user stays disabled.
      // Rejection reason is logged for audit but not persisted (no column
      // yet; revisit when an aggregator_decision_audit table lands).
      const dbUpdate = await store.updateStatus(aggregatorId, 'inactive', 'admin');
      if (!dbUpdate.ok) {
        log.error(
          {
            status: 'failure',
            sub_operation: 'store.updateStatus.inactive',
            code: dbUpdate.error.code,
            cause: dbUpdate.error.message,
          },
          'failed to flip aggregator status to inactive',
        );
        return sendHtml(
          reply,
          503,
          renderResultPage({
            status: 'error',
            title: 'Action failed',
            message: 'Database unavailable. Please try again shortly.',
          }),
        );
      }

      const stamp = await idp.setUserDecision(lookup.kcUser.id, 'rejected');
      if (!stamp.ok) {
        log.warn(
          {
            status: 'failure',
            sub_operation: 'idp.setUserDecision.rejected',
            code: stamp.error.code,
            cause: stamp.error.message,
          },
          'failed to stamp decision_made=rejected on KC user (drift-sync will repair)',
        );
      }

      const rejectedMail = renderApplicantRejected({
        contactName: applicantNameOf(lookup),
        association: lookup.aggregator.name,
        reason: parsed.data.reason,
      });
      const sendResult = await mailer.send({
        to: lookup.aggregator.contact.email,
        subject: rejectedMail.subject,
        html: rejectedMail.html,
        text: rejectedMail.text,
      });
      if (!sendResult.ok) {
        log.error(
          {
            status: 'failure',
            sub_operation: 'mailer.send.rejected',
            code: sendResult.error.code,
            cause: sendResult.error.message,
          },
          'rejected-email delivery failed',
        );
      }
      log.info(
        {
          status: 'success',
          decision: 'reject',
          new_status: 'inactive',
          reason: parsed.data.reason ?? null,
        },
        'aggregator rejected',
      );
      return sendHtml(
        reply,
        200,
        renderResultPage({
          status: 'success',
          title: 'Application rejected',
          message: `${lookup.aggregator.contact.email} has been notified.`,
        }),
      );
    },
  );
}

interface PriorDecision {
  decision: 'approved' | 'rejected';
}

/**
 * Maps `aggregators.status` to a prior-decision marker. Returning `null`
 * means the row is still in `pending` and the admin click should proceed.
 *
 * `retired` is treated as a prior approval (the aggregator was once active
 * and was later retired) so the approve button doesn't reactivate a retired
 * account behind the admin's back.
 */
function decisionFromStatus(status: Aggregator['status']): PriorDecision | null {
  switch (status) {
    case 'active':
    case 'retired':
      return { decision: 'approved' };
    case 'inactive':
      return { decision: 'rejected' };
    case 'pending':
    default:
      return null;
  }
}

function alreadyDecidedView(prior: PriorDecision): {
  status: 'info';
  title: string;
  message: string;
} {
  if (prior.decision === 'approved') {
    return {
      status: 'info',
      title: 'Already approved',
      message: 'This application has already been approved. No further action is required.',
    };
  }
  return {
    status: 'info',
    title: 'Already rejected',
    message: 'This application has already been rejected. No further action is required.',
  };
}

type LookupOk = { ok: true; aggregator: Aggregator; kcUser: IdpUser };
type LookupErr = { ok: false; status: number; html: string };

async function loadAggregatorAndUser(aggregatorId: string): Promise<LookupOk | LookupErr> {
  const store = getAggregatorStore();
  const idp = getIdpAdmin();

  const stored = await store.findById(aggregatorId);
  if (!stored.ok) {
    return {
      ok: false,
      status: 503,
      html: renderResultPage({
        status: 'error',
        title: 'Service unavailable',
        message: 'Could not load aggregator record.',
      }),
    };
  }
  if (!stored.value) {
    return {
      ok: false,
      status: 404,
      html: renderResultPage({
        status: 'error',
        title: 'Not found',
        message: 'Aggregator not found.',
      }),
    };
  }

  const kc = await idp.findByAttribute(KC_ATTR.AGGREGATOR_ID, aggregatorId);
  if (!kc.ok) {
    return {
      ok: false,
      status: 503,
      html: renderResultPage({
        status: 'error',
        title: 'Identity service unavailable',
        message: 'Could not load identity record.',
      }),
    };
  }
  if (!kc.value) {
    return {
      ok: false,
      status: 404,
      html: renderResultPage({
        status: 'error',
        title: 'Not found',
        message: 'Identity record missing.',
      }),
    };
  }
  return { ok: true, aggregator: stored.value, kcUser: kc.value };
}

function isIntent(v: unknown): v is 'approve' | 'reject' {
  return v === 'approve' || v === 'reject';
}

function tokenErrorMessage(code: 'EXPIRED' | 'INVALID' | 'MALFORMED'): string {
  switch (code) {
    case 'EXPIRED':
      return 'This approval link has expired. Ask the applicant to resubmit.';
    case 'INVALID':
      return 'Approval link signature is invalid.';
    case 'MALFORMED':
    default:
      return 'Approval link is malformed.';
  }
}

/**
 * Display name preference: Beckn contact.name → KC firstName+lastName →
 * email. Aggregator's `contact.name` is filled at registration; KC names
 * only appear after the applicant completes the Update Profile flow.
 */
function applicantNameOf(lookup: LookupOk): string {
  const contactName = lookup.aggregator.contact.name;
  if (contactName) return contactName;
  const parts = [lookup.kcUser.firstName, lookup.kcUser.lastName].filter((p): p is string =>
    Boolean(p),
  );
  return parts.length > 0 ? parts.join(' ') : lookup.kcUser.email;
}

function sendHtml(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply.status(status).type('text/html; charset=utf-8').send(html);
}
