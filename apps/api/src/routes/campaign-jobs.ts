/**
 * Campaign job status endpoints (aggregator-dpg#579).
 *
 *   GET /v1/campaign/export/{job_id} → one job's detail + per-item status
 *   GET /v1/campaign/export          → the org's jobs, newest first (paginated)
 *
 * Both are tenant-scoped by the token's `signalstack_org_id` — a job owned by
 * another org reads as not-found. Counts are derived from the item rows (never
 * a stored counter). Auth is the shared campaign-manager Bearer gate. These
 * back the caller's poll-for-status flow after a `202` from the export route.
 * Belongs to `@aggregator-dpg/api`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getCampaignJobStore } from '../services/campaign-job-store/index.js';
import { requireCampaignAuth, requireOrgId } from '../campaign/auth.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

const countsSchema = z.object({
  total: z.number().int(),
  pending: z.number().int(),
  resolved: z.number().int(),
  submitted: z.number().int(),
  sent: z.number().int(),
  skipped_not_owned: z.number().int(),
  skipped_no_contact: z.number().int(),
  duplicate_active: z.number().int(),
  failed: z.number().int(),
});

const channelSchema = z.enum(['export', 'email', 'voice']);
const jobStatusSchema = z.enum(['queued', 'processing', 'partial', 'completed', 'failed']);
const itemStatusSchema = z.enum([
  'pending',
  'resolved',
  'submitted',
  'sent',
  'skipped_not_owned',
  'skipped_no_contact',
  'duplicate_active',
  'failed',
]);
const metadataSchema = z.array(z.object({ key: z.string(), value: z.string() }));

const jobSummarySchema = z.object({
  job_id: z.string().uuid(),
  channel: channelSchema,
  status: jobStatusSchema,
  counts: countsSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * Registers the campaign job status + list routes.
 *
 * @param app - The Fastify instance to attach the routes to.
 */
export async function registerCampaignJobRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/campaign/export/:job_id',
    {
      schema: {
        tags: ['campaign'],
        summary: "Get one campaign job's status and per-item outcomes",
        description:
          'Returns the job status (derived from item counts) and each item id with its status and error reason. Tenant-scoped: a job owned by another org returns 404.',
        security: [{ bearerAuth: [] }],
        params: z.object({ job_id: z.string().uuid() }),
        response: {
          200: jobSummarySchema.extend({
            metadata: metadataSchema,
            items: z.array(
              z.object({
                item_id: z.string(),
                status: itemStatusSchema,
                provider_ref: z.string().nullable(),
                skip_reason: z.string().nullable(),
                error_reason: z.string().nullable(),
              }),
            ),
          }),
          ...errorResponses(401, 403),
        },
      },
    },
    async (req) => {
      const auth = await requireCampaignAuth(req);
      const orgId = requireOrgId(auth);
      const { job_id: jobId } = req.params as { job_id: string };

      const store = getCampaignJobStore();
      const job = await store.getJob(jobId, orgId);
      if (!job.ok) throw httpError('INTERNAL', { detail: 'could not read campaign job' });
      // Spec §5: another org's job is a 403, not a 404.
      if (!job.value) throw httpError('CAMPAIGN_JOB_FORBIDDEN');

      const items = await store.getJobItems(jobId, orgId);
      if (!items.ok) throw httpError('INTERNAL', { detail: 'could not read campaign job items' });

      return {
        job_id: job.value.id,
        channel: job.value.channel,
        status: job.value.status,
        counts: job.value.counts,
        metadata: job.value.metadata,
        items: (items.value ?? []).map((i) => ({
          item_id: i.itemId,
          status: i.status,
          provider_ref: i.providerRef,
          skip_reason: i.skipReason,
          error_reason: i.errorReason,
        })),
        created_at: job.value.createdAt.toISOString(),
        updated_at: job.value.updatedAt.toISOString(),
      };
    },
  );

  app.get(
    '/v1/campaign/export',
    {
      schema: {
        tags: ['campaign'],
        summary: "List the org's campaign jobs (newest first)",
        description:
          "Returns the requesting org's campaign jobs, newest first, with derived status counts. Optional channel filter and cursor pagination (pass the returned next_cursor to page).",
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          channel: channelSchema.optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          cursor: z.string().optional(),
        }),
        response: {
          200: z.object({
            jobs: z.array(jobSummarySchema),
            next_cursor: z.string().nullable(),
          }),
          ...errorResponses(401, 403),
        },
      },
    },
    async (req) => {
      const auth = await requireCampaignAuth(req);
      const orgId = requireOrgId(auth);
      const query = req.query as {
        channel?: 'export' | 'email' | 'voice';
        limit?: number;
        cursor?: string;
      };

      const store = getCampaignJobStore();
      const result = await store.listJobs(orgId, {
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      if (!result.ok) throw httpError('INTERNAL', { detail: 'could not list campaign jobs' });

      return {
        jobs: result.value.jobs.map((j) => ({
          job_id: j.id,
          channel: j.channel,
          status: j.status,
          counts: j.counts,
          created_at: j.createdAt.toISOString(),
          updated_at: j.updatedAt.toISOString(),
        })),
        next_cursor: result.value.nextCursor,
      };
    },
  );
}
