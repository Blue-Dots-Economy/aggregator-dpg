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
 *   POST /admin/v1/orgs/resend/:id   body { token }
 *     Re-mints + re-emails the review link for a still-pending org (§7).
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
import { formatApprovalTtl } from '../services/approval-token.js';
import { renderConfirmPage, renderResultPage } from '../views/approval-pages.js';
import { sendOrgReviewEmail } from '../services/org-registration-notify.js';
import { mintApprovalTokenPair } from '../services/registration-notify.js';
import {
  sendHtml,
  sendPage,
  missingTokenPage,
  notFoundPage,
  serviceUnavailablePage,
  verifyTokenForId,
  type HtmlPage,
} from './approval-shared.js';

const OrgDecisionBodySchema = z.object({
  token: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
});

const OrgApprovalParamsSchema = z.object({ id: z.string() });

const OrgReadQuerySchema = z.object({
  token: z.string().optional(),
  intent: z.string().optional(),
});

const ORG_NOUN = 'organisation';
const orgNotFoundPage = (): HtmlPage => notFoundPage('Not found', 'Organisation not found.');
const orgUnavailablePage = (): HtmlPage =>
  serviceUnavailablePage('Service unavailable', 'Could not load the organisation record.');

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

      if (!token) return sendPage(reply, missingTokenPage());

      // Accept an expired-but-signature-valid token as proof the network admin
      // held a legitimate link. Truly invalid/malformed tokens still fail.
      const verified = await verifyTokenForId(token, orgId, ORG_NOUN, { allowExpired: true });
      if (!verified.ok) return sendPage(reply, verified.page);

      const lookup = await getAggregatorOrgStore().findById(orgId);
      if (!lookup.ok) return sendPage(reply, orgUnavailablePage());
      if (!lookup.value) return sendPage(reply, orgNotFoundPage());

      const prior = orgDecidedView(lookup.value.status);
      if (prior) return sendHtml(reply, 200, renderResultPage(prior));

      const effectiveIntent = intent === 'reject' ? 'reject' : 'approve';
      // Re-arm the decision link inline: mint a fresh token so the approve/reject
      // POST always validates, even if the emailed link had expired. This lets
      // the admin (already on this page) act without a self-email round-trip (§7).
      const { approveToken, rejectToken } = await mintApprovalTokenPair(orgId);
      return sendHtml(
        reply,
        200,
        renderConfirmPage({
          aggregatorId: orgId,
          intent: effectiveIntent,
          token: effectiveIntent === 'reject' ? rejectToken : approveToken,
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

      const verified = await verifyTokenForId(parsed.data.token, orgId, ORG_NOUN);
      if (!verified.ok) return sendPage(reply, verified.page);

      const orgStore = getAggregatorOrgStore();
      const idp = getIdpAdmin();

      const lookup = await orgStore.findById(orgId);
      if (!lookup.ok) return sendPage(reply, orgUnavailablePage());
      if (!lookup.value) return sendPage(reply, orgNotFoundPage());

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
          return sendPage(
            reply,
            serviceUnavailablePage(
              'Action failed',
              'Identity service unavailable. Please try again shortly.',
            ),
          );
        }
      }

      // Atomic CAS commit. If a concurrent click already flipped it, the CAS
      // returns null → render already-decided.
      const cas = await orgStore.approve(orgId);
      if (!cas.ok) {
        return sendPage(
          reply,
          serviceUnavailablePage(
            'Action failed',
            'Database unavailable. Please try again shortly.',
          ),
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

      const verified = await verifyTokenForId(body.token ?? '', orgId, ORG_NOUN, {
        allowExpired: true,
      });
      if (!verified.ok) return sendPage(reply, verified.page);

      const lookup = await getAggregatorOrgStore().findById(orgId);
      if (!lookup.ok) return sendPage(reply, orgUnavailablePage());
      if (!lookup.value) return sendPage(reply, orgNotFoundPage());

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
