/**
 * Admin approval endpoints.
 *
 * URL shape mirrors the spec under `4.3.2 Endpoints by Actor & Action`:
 *
 *   GET  /admin/v1/aggregator-registrations/read/:id?token=...&intent=approve|reject
 *     Renders an HTML confirmation page that tells the admin which action
 *     they're about to take. If the Keycloak user already carries a
 *     `decision_made` attribute (i.e. a previous approve / reject click
 *     already ran), it instead renders an "already decided" page so
 *     duplicate clicks never resend emails — even on the reject path.
 *
 *   POST /admin/v1/aggregator-registrations/decision/:id
 *     Body: { token, decision: 'approve' | 'reject', reason? }
 *     Verifies the JWT, re-checks the `decision_made` KC attribute (single-
 *     use guard), applies the action, sends the applicant a notification
 *     email, stamps the user with `decision_made` + `decided_at` (+
 *     `rejection_reason` on reject), and returns a result HTML page.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { verifyApprovalToken } from '../services/approval-token.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { getMailer } from '../services/mailer/index.js';
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

      const prior = readDecision(lookup.kcUser);
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
          association: lookup.aggregator.orgSlug,
          aggregatorType: lookup.aggregator.type,
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

      // Single-use guard: if the user already carries a `decision_made`
      // attribute, ignore this replay (covers both approve and reject).
      const prior = readDecision(lookup.kcUser);
      if (prior) {
        return sendHtml(reply, 200, renderResultPage(alreadyDecidedView(prior)));
      }

      const idp = getIdpAdmin();
      const mailer = getMailer();
      const decidedAtIso = new Date().toISOString();

      if (parsed.data.decision === 'approve') {
        const enable = await idp.enableUser(lookup.kcUser.id);
        if (!enable.ok) {
          log.error(
            {
              status: 'failure',
              sub_operation: 'idp.enableUser',
              code: enable.error.code,
              cause: enable.error.message,
            },
            'failed to enable KC user during approval',
          );
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
        const stamp = await idp.setAttributes(lookup.kcUser.id, {
          [KC_ATTR.DECISION_MADE]: 'approved',
          [KC_ATTR.DECIDED_AT]: decidedAtIso,
          [KC_ATTR.REJECTION_REASON]: null,
        });
        if (!stamp.ok) {
          log.warn(
            {
              status: 'failure',
              sub_operation: 'idp.setAttributes.approved',
              code: stamp.error.code,
              cause: stamp.error.message,
            },
            'failed to stamp decision attributes (approved)',
          );
        }
        const approvedMail = renderApplicantApproved({
          contactName: applicantNameOf(lookup.kcUser),
          association: lookup.aggregator.orgSlug,
          identifier: lookup.kcUser.email,
          signInUrl: `${config.PUBLIC_PORTAL_URL}/login`,
        });
        const sendResult = await mailer.send({
          to: lookup.kcUser.email,
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
        log.info({ status: 'success', decision: 'approve' }, 'aggregator approved');
        return sendHtml(
          reply,
          200,
          renderResultPage({
            status: 'success',
            title: 'Application approved',
            message: `${lookup.kcUser.email} can now sign in to the portal.`,
          }),
        );
      }

      // Reject path — KC user stays disabled. Stamp `decision_made` so
      // duplicate reject clicks don't resend the rejection email.
      const stamp = await idp.setAttributes(lookup.kcUser.id, {
        [KC_ATTR.DECISION_MADE]: 'rejected',
        [KC_ATTR.DECIDED_AT]: decidedAtIso,
        ...(parsed.data.reason ? { [KC_ATTR.REJECTION_REASON]: parsed.data.reason } : {}),
      });
      if (!stamp.ok) {
        log.warn(
          {
            status: 'failure',
            sub_operation: 'idp.setAttributes.rejected',
            code: stamp.error.code,
            cause: stamp.error.message,
          },
          'failed to stamp decision attributes (rejected)',
        );
      }
      const rejectedMail = renderApplicantRejected({
        contactName: applicantNameOf(lookup.kcUser),
        association: lookup.aggregator.orgSlug,
        reason: parsed.data.reason,
      });
      const sendResult = await mailer.send({
        to: lookup.kcUser.email,
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
      log.info({ status: 'success', decision: 'reject' }, 'aggregator rejected');
      return sendHtml(
        reply,
        200,
        renderResultPage({
          status: 'success',
          title: 'Application rejected',
          message: `${lookup.kcUser.email} has been notified.`,
        }),
      );
    },
  );
}

interface PriorDecision {
  decision: 'approved' | 'rejected';
  decidedAt?: string;
}

function readDecision(user: IdpUser): PriorDecision | null {
  const raw = user.attributes?.[KC_ATTR.DECISION_MADE]?.[0];
  if (raw !== 'approved' && raw !== 'rejected') return null;
  const decidedAt = user.attributes?.[KC_ATTR.DECIDED_AT]?.[0];
  return decidedAt ? { decision: raw, decidedAt } : { decision: raw };
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

function applicantNameOf(user: { firstName?: string; lastName?: string; email: string }): string {
  const parts = [user.firstName, user.lastName].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' ') : user.email;
}

function sendHtml(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply.status(status).type('text/html; charset=utf-8').send(html);
}
