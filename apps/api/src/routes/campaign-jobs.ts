/**
 * Campaign job status endpoints (aggregator-dpg#579).
 *
 *   GET /v1/campaign/{channel}/{job_id} → one job's detail + per-item status
 *   GET /v1/campaign/{channel}          → the org's jobs, newest first
 *
 * Per the contract spec §5 the poll pair is **per channel**, so this module
 * exports a factory: `registerCampaignJobRoutes(app, 'export')` mounts
 * `/v1/campaign/export*`, and #578/#577 mount `/email*` and `/voice*` the same
 * way. The routes are scoped BOTH ways — a job belonging to another org *or*
 * to another channel is a 403, never returned and never confirmed to exist.
 *
 * Counts are derived from the item rows (never a stored counter). Auth is the
 * shared campaign-manager Bearer gate. These back the caller's poll-for-status
 * flow after a `202` from the submit route. Belongs to `@aggregator-dpg/api`.
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

/** A campaign channel that owns a poll-endpoint pair. */
export type CampaignRouteChannel = z.infer<typeof channelSchema>;

/**
 * Registers the status + list poll pair for ONE campaign channel.
 *
 * @param app - The Fastify instance to attach the routes to.
 * @param channel - The channel these routes serve; it scopes every lookup, so
 *   `/v1/campaign/export/{id}` never returns an email or voice job.
 */
export async function registerCampaignJobRoutes(
  app: FastifyInstance,
  channel: CampaignRouteChannel,
): Promise<void> {
  app.get(
    `/v1/campaign/${channel}/:job_id`,
    {
      schema: {
        tags: ['campaign'],
        summary: `Get one ${channel} job's status and per-item outcomes`,
        description: `Returns the job status (derived from item counts) and each item id with its status, provider ref and skip/error reason. Scoped to this org and to the ${channel} channel — a job belonging to another org or channel returns 403.`,
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
      // Spec §5: another org's job is a 403, not a 404. A job on a different
      // channel is the same answer — this path only serves `channel`, and
      // saying "wrong channel" would confirm the id exists.
      if (!job.value || job.value.channel !== channel) throw httpError('CAMPAIGN_JOB_FORBIDDEN');

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
    `/v1/campaign/${channel}`,
    {
      schema: {
        tags: ['campaign'],
        summary: `List the org's ${channel} jobs (newest first)`,
        description: `Returns the requesting org's ${channel} jobs, newest first, with derived status counts. Cursor pagination — pass the returned next_cursor to page.`,
        security: [{ bearerAuth: [] }],
        // No `channel` filter: the path already fixes it.
        querystring: z.object({
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
      const query = req.query as { limit?: number; cursor?: string };

      const store = getCampaignJobStore();
      const result = await store.listJobs(orgId, {
        channel,
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
