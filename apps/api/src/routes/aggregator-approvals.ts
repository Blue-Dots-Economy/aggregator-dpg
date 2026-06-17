/**
 * Admin approval endpoints — FSM-based registration flow.
 *
 * URL shape:
 *
 *   GET  /admin/v1/aggregator-registrations/read/:id?token=...&intent=approve|reject
 *     Renders an HTML confirmation page. `id` is a `registrationId`. If the
 *     registration is already in a terminal or post-verified state the page
 *     shows "already decided".
 *
 *   POST /admin/v1/aggregator-registrations/decision/:id
 *     Body: { token, decision: 'approve' | 'reject', reason? }
 *     Verifies the registration-approval JWT, compare-and-sets
 *     `verified → approved|rejected`, then kicks best-effort provisioning
 *     (graduated aggregator row, KC user, SS org, applicant emails).
 *     The reconciler guarantees convergence if any inline step fails.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { verifyRegistrationApprovalToken } from '../services/approval-token.js';
import { getRegistrationStore } from '../services/registration-store/index.js';
import type { Registration } from '../services/registration-store/index.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getAggregatorProfileStore } from '../services/aggregator-profile-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { getMailer } from '../services/mailer/index.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import {
  ensureGraduated,
  ensureKeycloakUser,
  ensureKeycloakUserDisabled,
  ensureSignalstackOrg,
  ensureWelcomeSent,
  ensureRejectionSent,
} from '../services/registration-provisioning/index.js';
import { renderConfirmPage, renderResultPage } from '../views/approval-pages.js';
import { logger } from '../logger.js';

const DecisionBodySchema = z.object({
  token: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(2000).optional(),
});

export async function registerAggregatorApprovalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Renders the admin confirmation page for an approve/reject action.
   *
   * `id` is the `registrationId`. The token is a registration-approval JWT
   * with sub=registrationId and intent=approve|reject.
   */
  app.get(
    '/admin/v1/aggregator-registrations/read/:id',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Querystring: { token?: string; intent?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const registrationId = req.params.id;
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

      const verified = await verifyRegistrationApprovalToken(token);
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
      if (verified.registrationId !== registrationId) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Invalid link',
            message: 'Token does not match the requested registration.',
          }),
        );
      }

      const effectiveIntent = isIntent(intent) ? intent : verified.intent;

      const store = getRegistrationStore();
      const regResult = await store.findById(registrationId);
      if (!regResult.ok) {
        return sendHtml(
          reply,
          503,
          renderResultPage({
            status: 'error',
            title: 'Service unavailable',
            message: 'Could not load registration record.',
          }),
        );
      }
      if (!regResult.value) {
        return sendHtml(
          reply,
          404,
          renderResultPage({
            status: 'error',
            title: 'Not found',
            message: 'Registration not found.',
          }),
        );
      }

      const reg = regResult.value;
      const prior = priorDecision(reg.state);
      if (prior) {
        return sendHtml(reply, 200, renderResultPage(alreadyDecidedView(prior)));
      }

      return sendHtml(
        reply,
        200,
        renderConfirmPage({
          aggregatorId: registrationId,
          intent: effectiveIntent,
          token,
          applicantEmail: reg.contactEmail,
          association: reg.orgName,
          aggregatorType: reg.orgType ?? 'aggregator',
          postUrl: `${config.PUBLIC_API_URL}/admin/v1/aggregator-registrations/decision/${registrationId}`,
        }),
      );
    },
  );

  /**
   * Processes the admin approve/reject decision.
   *
   * Performs a compare-and-set `verified → approved|rejected` then fires
   * best-effort provisioning. All external effects are idempotent so the
   * admin can re-click the link if needed.
   */
  app.post(
    '/admin/v1/aggregator-registrations/decision/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const registrationId = req.params.id;
      const start = Date.now();

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

      const verified = await verifyRegistrationApprovalToken(parsed.data.token);
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
      if (verified.registrationId !== registrationId) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Invalid link',
            message: 'Token does not match the requested registration.',
          }),
        );
      }

      const store = getRegistrationStore();
      const regResult = await store.findById(registrationId);
      if (!regResult.ok) {
        return sendHtml(
          reply,
          503,
          renderResultPage({
            status: 'error',
            title: 'Service unavailable',
            message: 'Could not load registration record.',
          }),
        );
      }
      if (!regResult.value) {
        return sendHtml(
          reply,
          404,
          renderResultPage({
            status: 'error',
            title: 'Not found',
            message: 'Registration not found.',
          }),
        );
      }

      const reg = regResult.value;

      // Single-use guard: if already decided (post-verified), show result page.
      const prior = priorDecision(reg.state);
      if (prior) {
        return sendHtml(reply, 200, renderResultPage(alreadyDecidedView(prior)));
      }

      if (reg.state !== 'verified') {
        return sendHtml(
          reply,
          409,
          renderResultPage({
            status: 'error',
            title: 'Action not available',
            message: `Registration is in state '${reg.state}'. Only verified registrations can be approved or rejected.`,
          }),
        );
      }

      if (parsed.data.decision === 'approve') {
        return handleApprove(reg, store, start, reply);
      }
      return handleReject(reg, parsed.data.reason, store, start, reply);
    },
  );
}

async function handleApprove(
  reg: Registration,
  store: ReturnType<typeof getRegistrationStore>,
  start: number,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const log = logger.child({ operation: 'aggregator-approval.approve', registration_id: reg.id });
  // Compare-and-set verified → approved.
  const transResult = await store.transition(reg.id, 'verified', 'approved', {}, reg.version, {
    actor: 'admin',
    reason: 'approval',
  });

  if (!transResult.ok) {
    if (transResult.error.code === 'STALE_TRANSITION') {
      // Concurrent decision won — treat as "already decided".
      return sendHtml(reply, 200, renderResultPage(alreadyDecidedView({ decision: 'approved' })));
    }
    return sendHtml(
      reply,
      503,
      renderResultPage({
        status: 'error',
        title: 'Service unavailable',
        message: 'Could not record decision. Please try again.',
      }),
    );
  }

  const approvedReg = transResult.value;

  // Best-effort inline provisioning. Each executor is idempotent; the
  // reconciler guarantees convergence if any step fails here.
  void (async () => {
    const registrationId = reg.id;
    try {
      const deps = {
        store,
        aggregatorStore: getAggregatorStore(),
        aggregatorProfileStore: getAggregatorProfileStore(),
      };
      await ensureGraduated(approvedReg, deps);

      // Re-read for fresh aggregatorId after graduation.
      const freshResult = await store.findById(registrationId);
      const freshReg = freshResult.ok && freshResult.value ? freshResult.value : approvedReg;

      await ensureKeycloakUser(freshReg, { store, idpAdmin: getIdpAdmin() });

      const ssWriter = getSignalStackWriter();
      if (ssWriter) {
        await ensureSignalstackOrg(freshReg, {
          store,
          signalStackWriter: ssWriter,
          aggregatorStore: getAggregatorStore(),
        });
      }

      await ensureWelcomeSent(freshReg, {
        store,
        mailer: getMailer(),
        portalUrl: config.PUBLIC_PORTAL_URL,
      });
    } catch (err) {
      logger.warn({
        operation: 'aggregator-approval.approve.inline_provision',
        status: 'failure',
        registration_id: registrationId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  })();

  log.info(
    { status: 'success', decision: 'approve', latency_ms: Date.now() - start },
    'registration approved',
  );
  return sendHtml(
    reply,
    200,
    renderResultPage({
      status: 'success',
      title: 'Application approved',
      message: `${reg.contactEmail} will receive a welcome email once provisioning completes.`,
    }),
  );
}

async function handleReject(
  reg: Registration,
  reason: string | undefined,
  store: ReturnType<typeof getRegistrationStore>,
  start: number,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const log = logger.child({ operation: 'aggregator-approval.reject', registration_id: reg.id });
  // Compare-and-set verified → rejected.
  const transResult = await store.transition(reg.id, 'verified', 'rejected', {}, reg.version, {
    actor: 'admin',
    reason: reason ?? 'rejection',
  });

  if (!transResult.ok) {
    if (transResult.error.code === 'STALE_TRANSITION') {
      return sendHtml(reply, 200, renderResultPage(alreadyDecidedView({ decision: 'rejected' })));
    }
    return sendHtml(
      reply,
      503,
      renderResultPage({
        status: 'error',
        title: 'Service unavailable',
        message: 'Could not record decision. Please try again.',
      }),
    );
  }

  const rejectedReg = transResult.value;

  // Best-effort inline provisioning.
  void (async () => {
    const registrationId = reg.id;
    try {
      await ensureKeycloakUserDisabled(rejectedReg, { store, idpAdmin: getIdpAdmin() });
      await ensureRejectionSent(rejectedReg, {
        store,
        mailer: getMailer(),
        ...(reason !== undefined ? { reason } : {}),
      });
    } catch (err) {
      logger.warn({
        operation: 'aggregator-approval.reject.inline_provision',
        status: 'failure',
        registration_id: registrationId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  })();

  log.info(
    { status: 'success', decision: 'reject', latency_ms: Date.now() - start },
    'registration rejected',
  );
  return sendHtml(
    reply,
    200,
    renderResultPage({
      status: 'success',
      title: 'Application rejected',
      message: `${reg.contactEmail} will be notified.`,
    }),
  );
}

interface PriorDecision {
  decision: 'approved' | 'rejected';
}

function priorDecision(state: Registration['state']): PriorDecision | null {
  switch (state) {
    case 'approved':
    case 'active':
      return { decision: 'approved' };
    case 'rejected':
    case 'abandoned':
      return { decision: 'rejected' };
    case 'verified':
    case 'submitted':
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
      message: 'This application has already been approved.',
    };
  }
  return {
    status: 'info',
    title: 'Already rejected',
    message: 'This application has already been rejected.',
  };
}

function isIntent(v: unknown): v is 'approve' | 'reject' {
  return v === 'approve' || v === 'reject';
}

function tokenErrorMessage(code: 'EXPIRED' | 'INVALID' | 'MALFORMED'): string {
  switch (code) {
    case 'EXPIRED':
      return 'This approval link has expired. Please contact the applicant to request a new verification.';
    case 'INVALID':
      return 'Approval link signature is invalid.';
    case 'MALFORMED':
    default:
      return 'Approval link is malformed.';
  }
}

function sendHtml(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply.status(status).type('text/html; charset=utf-8').send(html);
}
