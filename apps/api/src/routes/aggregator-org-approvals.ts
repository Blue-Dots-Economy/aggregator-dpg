/**
 * Org approval endpoints (spec §6.1 / §8 org column).
 *
 * Always registered: the org hierarchy is always on since migration 0028.
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
import { config } from '../config.js';
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
import type { AggregatorOrg } from '../services/aggregator-org-store/index.js';
import { formatApprovalTtl } from '../services/approval-token.js';
import { renderConfirmPage, renderResultPage } from '../views/approval-pages.js';
import { mintReviewToken } from '../services/registration-notify.js';
import { decideOrg } from '../services/decisions/org.js';
import { LINK_DECIDER } from '../services/decisions/coordinator.js';
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
  /** Same cap as the coordinator decision route; surfaced to the applicant. */
  reason: z.string().max(2000).optional(),
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
 * Registers the org approval routes.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export async function registerAggregatorOrgApprovalRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/v1/orgs/read/:id',
    {
      config: { rbac: { access: 'link_token' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Render the network-admin approve/reject page for an org',
        description:
          'HTML page reached from the network-admin notification email. All responses are text/html.',
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
      const { token } = req.query;

      if (!token) return sendPage(reply, missingTokenPage());

      // Strict verify first (rejects expired). A valid link → straight to the
      // confirm page.
      const verified = await verifyTokenForId(token, orgId, ORG_NOUN);
      if (!verified.ok) {
        // If it's merely expired (signature valid, id matches), offer inline
        // regeneration — the admin clicks once to mint a fresh link and land on
        // the confirm page, no self-email round-trip (§7). Otherwise (invalid /
        // malformed / wrong id) show the original error page.
        const lenient = await verifyTokenForId(token, orgId, ORG_NOUN, { allowExpired: true });
        if (lenient.ok) {
          return sendHtml(
            reply,
            400,
            renderResultPage({
              status: 'error',
              title: 'Link expired',
              message:
                'This approval link has expired. Click below to regenerate a fresh link and continue to the review.',
              action: {
                url: `${config.PUBLIC_API_URL}/admin/v1/orgs/renew/${orgId}`,
                token,
                label: 'Regenerate & review',
              },
            }),
          );
        }
        return sendPage(reply, verified.page);
      }

      const lookup = await getAggregatorOrgStore().findById(orgId);
      if (!lookup.ok) return sendPage(reply, orgUnavailablePage());
      if (!lookup.value) return sendPage(reply, orgNotFoundPage());

      const prior = orgDecidedView(lookup.value.status);
      if (prior) return sendHtml(reply, 200, renderResultPage(prior));

      return sendHtml(
        reply,
        200,
        renderConfirmPage({
          aggregatorId: orgId,
          token,
          applicantEmail: lookup.value.ownerEmail,
          association: lookup.value.displayName,
          aggregatorType: 'organisation',
          entityLabel: 'organisation',
          postUrl: `${config.PUBLIC_API_URL}/admin/v1/orgs/decision/${orgId}`,
          expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
        }),
      );
    },
  );

  app.post(
    '/admin/v1/orgs/decision/:id',
    {
      config: { rbac: { access: 'link_token' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Approve or reject a pending org',
        description:
          'Browser form flow; every response is text/html. Both decisions are an atomic status CAS from pending first; approve then enables the owner (Keycloak user, org_owner role, group) and mails a sign-in link; reject mails the owner.',
        params: OrgApprovalParamsSchema,
      },
    },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const orgId = req.params.id;

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

      const outcome = await decideOrg({
        orgId,
        decision: parsed.data.decision,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        decidedBy: LINK_DECIDER,
        log: req.log,
      });
      switch (outcome.kind) {
        case 'decided':
          return sendHtml(
            reply,
            200,
            renderResultPage(
              outcome.decision === 'approve'
                ? {
                    status: 'success',
                    title: 'Organisation approved',
                    message:
                      'The organisation is now live. Its owner can sign in, and coordinators can register under it.',
                  }
                : {
                    status: 'success',
                    title: 'Organisation rejected',
                    message: outcome.notified
                      ? 'The owner has been notified.'
                      : 'The organisation was rejected, but the notification email could not be delivered.',
                  },
            ),
          );
        case 'already_decided': {
          const prior = orgDecidedView(outcome.status);
          return sendHtml(
            reply,
            200,
            renderResultPage((prior ?? orgDecidedView('active')) as ResultView),
          );
        }
        case 'not_found':
          return sendPage(reply, orgNotFoundPage());
        case 'unavailable':
          return sendPage(
            reply,
            serviceUnavailablePage(
              'Action failed',
              'Database unavailable. Please try again shortly.',
            ),
          );
      }
    },
  );

  app.post(
    '/admin/v1/orgs/renew/:id',
    {
      config: { rbac: { access: 'link_token' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Regenerate an expired org review link and show the confirm page',
        description:
          'Reached from the "Regenerate & review" button on the expired-link page. Accepts an expired-but-signature-valid token as proof the admin held a legitimate link, mints a fresh decision token, and renders the approve/reject confirm page inline (no email).',
        params: OrgApprovalParamsSchema,
      },
    },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
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

      // Mint a fresh review token, then land the admin on the review page
      // directly (approve/reject chosen there).
      const freshToken = await mintReviewToken(orgId);
      return sendHtml(
        reply,
        200,
        renderConfirmPage({
          aggregatorId: orgId,
          token: freshToken,
          applicantEmail: lookup.value.ownerEmail,
          association: lookup.value.displayName,
          aggregatorType: 'organisation',
          entityLabel: 'organisation',
          postUrl: `${config.PUBLIC_API_URL}/admin/v1/orgs/decision/${orgId}`,
          expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
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
