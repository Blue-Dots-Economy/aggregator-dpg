/**
 * Org approval endpoints (spec §6.1 / §8 org column).
 *
 * Flag-gated by `ORG_HIERARCHY_ENABLED`: not registered when the flag is off.
 *
 *   GET  /admin/v1/orgs/read/:id?token=...&intent=approve|reject
 *     HTML confirmation page reached from the network-admin review email.
 *
 *   POST /admin/v1/orgs/decision/:id   body { token, decision }
 *     approve → enable owner KC user + assign `org_owner` role + add owner to
 *       the mirrored group, then atomic CAS `aggregator_orgs` pending→active
 *       (the single-use commit). reject → atomic CAS pending→inactive.
 *
 * The org token carries no `org` claim — the **network admin** is the approver
 * (spec §9). Provisioning is an ordered, idempotent sequence: the owner-enable
 * hard-gate runs before the status CAS so a failure leaves the org pending and
 * the link re-clickable. Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config, orgHierarchyEnabled } from '../config.js';
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
import type { AggregatorOrg } from '../services/aggregator-org-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { verifyApprovalToken, formatApprovalTtl } from '../services/approval-token.js';
import { renderConfirmPage, renderResultPage } from '../views/approval-pages.js';
import { sendOrgReviewEmail } from '../services/org-registration-notify.js';

const OrgDecisionBodySchema = z.object({
  token: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
});

const OrgApprovalParamsSchema = z.object({ id: z.string() });

const OrgReadQuerySchema = z.object({
  token: z.string().optional(),
  intent: z.string().optional(),
});

/**
 * Registers the org approval routes. No-op (routes absent) when the org
 * hierarchy is disabled, preserving flag-off behaviour.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export async function registerAggregatorOrgApprovalRoutes(app: FastifyInstance): Promise<void> {
  if (!orgHierarchyEnabled()) return;

  app.get(
    '/admin/v1/orgs/read/:id',
    {
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Render the network-admin approve/reject page for an org',
        description:
          'HTML page reached from the network-admin notification email. All responses are text/html. Only registered when ORG_HIERARCHY_ENABLED=true.',
        params: OrgApprovalParamsSchema,
        querystring: OrgReadQuerySchema,
      },
    },
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Querystring: { token?: string; intent?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const orgId = req.params.id;
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
        const isExpired = verified.error.code === 'EXPIRED';
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: isExpired ? 'Link expired' : 'Invalid link',
            message: orgTokenErrorMessage(verified.error.code),
            // On expiry, offer to re-mint + re-send the review link to the
            // network admin (§7). Uses the expired-but-signed token as proof.
            ...(isExpired
              ? {
                  action: {
                    url: `${config.PUBLIC_API_URL}/admin/v1/orgs/resend/${orgId}`,
                    token,
                    label: 'Resend approval link',
                  },
                }
              : {}),
          }),
        );
      }
      if (verified.aggregatorId !== orgId) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Invalid link',
            message: 'Token does not match the requested organisation.',
          }),
        );
      }

      const lookup = await getAggregatorOrgStore().findById(orgId);
      if (!lookup.ok) {
        return sendHtml(
          reply,
          503,
          renderResultPage({
            status: 'error',
            title: 'Service unavailable',
            message: 'Could not load the organisation record.',
          }),
        );
      }
      if (!lookup.value) {
        return sendHtml(
          reply,
          404,
          renderResultPage({
            status: 'error',
            title: 'Not found',
            message: 'Organisation not found.',
          }),
        );
      }

      const prior = orgDecidedView(lookup.value.status);
      if (prior) return sendHtml(reply, 200, renderResultPage(prior));

      const effectiveIntent = intent === 'reject' ? 'reject' : 'approve';
      return sendHtml(
        reply,
        200,
        renderConfirmPage({
          aggregatorId: orgId,
          intent: effectiveIntent,
          token,
          applicantEmail: lookup.value.ownerEmail,
          association: lookup.value.displayName,
          aggregatorType: 'organisation',
          postUrl: `${config.PUBLIC_API_URL}/admin/v1/orgs/decision/${orgId}`,
          expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
        }),
      );
    },
  );

  app.post(
    '/admin/v1/orgs/decision/:id',
    {
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Approve or reject a pending org',
        description:
          'Browser form flow; every response is text/html. approve = enable owner + org_owner role + group + atomic status CAS; reject = atomic status CAS to inactive. Only registered when ORG_HIERARCHY_ENABLED=true.',
        params: OrgApprovalParamsSchema,
      },
    },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const orgId = req.params.id;
      const log = req.log.child({ operation: 'org-approval.decide', org_id: orgId });

      const parsed = OrgDecisionBodySchema.safeParse(req.body);
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
            message: orgTokenErrorMessage(verified.error.code),
          }),
        );
      }
      if (verified.aggregatorId !== orgId) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Invalid link',
            message: 'Token does not match the requested organisation.',
          }),
        );
      }

      const orgStore = getAggregatorOrgStore();
      const idp = getIdpAdmin();

      const lookup = await orgStore.findById(orgId);
      if (!lookup.ok) {
        return sendHtml(
          reply,
          503,
          renderResultPage({
            status: 'error',
            title: 'Service unavailable',
            message: 'Could not load the organisation record.',
          }),
        );
      }
      if (!lookup.value) {
        return sendHtml(
          reply,
          404,
          renderResultPage({
            status: 'error',
            title: 'Not found',
            message: 'Organisation not found.',
          }),
        );
      }

      // Single-use guard: anything other than pending is already decided.
      const prior = orgDecidedView(lookup.value.status);
      if (prior) return sendHtml(reply, 200, renderResultPage(prior));

      if (parsed.data.decision === 'reject') {
        await orgStore.reject(orgId);
        log.info({ status: 'success', decision: 'reject', new_status: 'inactive' }, 'org rejected');
        return sendHtml(
          reply,
          200,
          renderResultPage({
            status: 'success',
            title: 'Organisation rejected',
            message: 'The applicant has been notified.',
          }),
        );
      }

      // Approve. Hard-gate: enable the owner BEFORE the status CAS so a failed
      // enable leaves the org pending and the link re-clickable (enable is
      // idempotent). The owner KC user is created at submit (spec §6.1).
      const ownerKcSub = lookup.value.ownerKcSub;
      if (ownerKcSub) {
        const enabled = await idp.enableUser(ownerKcSub);
        if (!enabled.ok) {
          log.error(
            { status: 'failure', sub_operation: 'idp.enableUser', code: enabled.error.code },
            'failed to enable org owner — approval aborted, link still works',
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
      }

      // Atomic CAS commit. If a concurrent click already flipped it, the CAS
      // returns null → render already-decided.
      const cas = await orgStore.approve(orgId);
      if (!cas.ok) {
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
      if (cas.value === null) {
        return sendHtml(reply, 200, renderResultPage(orgDecidedView('active') as ResultView));
      }

      // Soft-fail provisioning: role + group mirror. Failures are logged and
      // repaired later; the org is live (status committed above).
      if (ownerKcSub) {
        const role = await idp.assignRealmRole(ownerKcSub, 'org_owner');
        if (!role.ok) {
          log.warn(
            { status: 'failure', sub_operation: 'idp.assignRealmRole', code: role.error.code },
            'failed to assign org_owner role (org is active; repair on next pass)',
          );
        }
        if (lookup.value.kcGroupId) {
          const grp = await idp.addUserToGroup(ownerKcSub, lookup.value.kcGroupId);
          if (!grp.ok) {
            log.warn(
              { status: 'failure', sub_operation: 'idp.addUserToGroup', code: grp.error.code },
              'failed to add owner to mirrored group (org is active; repair on next pass)',
            );
          }
        }
      }

      log.info({ status: 'success', decision: 'approve', new_status: 'active' }, 'org approved');
      return sendHtml(
        reply,
        200,
        renderResultPage({
          status: 'success',
          title: 'Organisation approved',
          message: 'The organisation is now live. Coordinators can register under it.',
        }),
      );
    },
  );

  app.post(
    '/admin/v1/orgs/resend/:id',
    {
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Resend a fresh org review link to the network admin',
        description:
          'Re-mints the approve/reject token pair and re-emails the network admin for a still-pending org (§7). Accepts an expired-but-signature-valid token as proof the caller held a legitimate link. Returns an HTML result page. Only registered when ORG_HIERARCHY_ENABLED=true.',
        params: OrgApprovalParamsSchema,
      },
    },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'org-registration.resend' });
      const orgId = req.params.id;
      const body = (req.body ?? {}) as { token?: string };
      const token = typeof body.token === 'string' ? body.token : '';

      const verified = await verifyApprovalToken(token, { allowExpired: true });
      if (!verified.ok) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Invalid link',
            message: orgTokenErrorMessage(verified.error.code),
          }),
        );
      }
      if (verified.aggregatorId !== orgId) {
        return sendHtml(
          reply,
          400,
          renderResultPage({
            status: 'error',
            title: 'Invalid link',
            message: 'Token does not match the requested organisation.',
          }),
        );
      }

      const lookup = await getAggregatorOrgStore().findById(orgId);
      if (!lookup.ok) {
        return sendHtml(
          reply,
          503,
          renderResultPage({
            status: 'error',
            title: 'Service unavailable',
            message: 'Could not load the organisation record.',
          }),
        );
      }
      if (!lookup.value) {
        return sendHtml(
          reply,
          404,
          renderResultPage({
            status: 'error',
            title: 'Not found',
            message: 'Organisation not found.',
          }),
        );
      }

      const prior = orgDecidedView(lookup.value.status);
      if (prior) return sendHtml(reply, 200, renderResultPage(prior));

      await sendOrgReviewEmail(
        {
          orgId,
          displayName: lookup.value.displayName,
          ownerEmail: lookup.value.ownerEmail,
          ownerPhone: lookup.value.ownerPhone ?? '',
        },
        log,
      );

      log.info({ status: 'success', org_id: orgId }, 'org approval link resent');
      return sendHtml(
        reply,
        200,
        renderResultPage({
          status: 'success',
          title: 'Approval link sent',
          message: 'A fresh approval link has been emailed to the reviewers.',
        }),
      );
    },
  );
}

type ResultView = { status: 'success' | 'error' | 'info'; title: string; message: string };

/**
 * Maps an org status to an already-decided result view, or `null` when the
 * org is still `pending` and the decision should proceed.
 *
 * @param status - The org's lifecycle status.
 * @returns A result-page view for terminal states, else `null`.
 */
function orgDecidedView(status: AggregatorOrg['status']): ResultView | null {
  if (status === 'pending') return null;
  if (status === 'active' || status === 'retired') {
    return {
      status: 'info',
      title: 'Already approved',
      message: 'This organisation has already been approved. No further action is required.',
    };
  }
  return {
    status: 'info',
    title: 'Already rejected',
    message: 'This organisation has already been rejected. No further action is required.',
  };
}

/**
 * User-facing copy for an org approval-token failure.
 *
 * @param code - The verify failure code.
 * @returns A sentence shown on the org result page.
 */
function orgTokenErrorMessage(code: 'EXPIRED' | 'INVALID' | 'MALFORMED'): string {
  switch (code) {
    case 'EXPIRED':
      return 'This approval link has expired. Ask the network admin to resend it.';
    case 'INVALID':
      return 'Approval link signature is invalid.';
    case 'MALFORMED':
    default:
      return 'Approval link is malformed.';
  }
}

/**
 * Sends an HTML response with the given status.
 *
 * @param reply - Fastify reply.
 * @param status - HTTP status code.
 * @param html - Rendered HTML body.
 * @returns The reply for chaining.
 */
function sendHtml(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply.status(status).type('text/html; charset=utf-8').send(html);
}
