/**
 * Onboarding service for the web app: registration links and bulk uploads.
 *
 * Runs in the browser and calls the BFF, which attaches the bearer token.
 */

import { z } from 'zod';
import { ResponseShapeError } from '@/lib/response-shape-error';
import { jsonFetch } from './http';

/** Submitted, passed, failed and skipped counts. */
const OutcomeCountsSchema = z.object({
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
});

export const ApiRegistrationLinkSchema = z.object({
  link_id: z.string(),
  slug: z.string(),
  domain: z.string(),
  status: z.enum(['draft', 'live', 'retired']),
  /**
   * Registration mode key (e.g. `voice`, `form`), set at creation and
   * immutable. The network config maps modes to form shapes.
   */
  registration_mode: z.string().optional(),
  context: z.record(z.unknown()),
  expires_at: z.string().nullable(),
  /** Set only while the link is live; `null` for drafts and retired links. */
  public_url: z.string().nullable(),
  qr_url: z.string().nullable(),
  qr_expires_at: z.string().nullable(),
  /** Submission counters from the listing endpoint. Zero when there are none. */
  metrics: OutcomeCountsSchema.optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ApiRegistrationLink = z.infer<typeof ApiRegistrationLinkSchema>;

export const ListLinksResponseSchema = z.object({
  items: z.array(ApiRegistrationLinkSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
export type ListLinksResponse = z.infer<typeof ListLinksResponseSchema>;

export interface CreateLinkInput {
  domain: string;
  /** Optional human-readable slug. Server falls back to random when omitted. */
  slug?: string;
  /** Display label shown as the card title. Stored on `context.title`. */
  title?: string;
  context?: Record<string, unknown>;
  status?: 'draft' | 'live';
  /**
   * Registration mode key (e.g. `voice`, `form`), checked by the API against
   * the network config. Defaults to `form`. Immutable after creation.
   */
  registration_mode?: string;
  expires_at?: string | null;
}

/** Patch for `PATCH /api/links/:id`. Applies to drafts only; other links return 409. */
export interface UpdateLinkInput {
  slug?: string;
  context?: Record<string, unknown>;
  expires_at?: string | null;
}

export const OnboardingSummarySchema = OutcomeCountsSchema.extend({
  aggregator_id: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type OnboardingSummary = z.infer<typeof OnboardingSummarySchema>;

/** One entry-source slice of the onboarding rollup (`source` is `bulk` or `link`). */
export const OnboardingSourceSliceSchema = OutcomeCountsSchema.extend({ source: z.string() });
export type OnboardingSourceSlice = z.infer<typeof OnboardingSourceSliceSchema>;

export const OnboardingBySourceSchema = z.object({
  aggregator_id: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  by_source: z.array(OnboardingSourceSliceSchema),
});
export type OnboardingBySource = z.infer<typeof OnboardingBySourceSchema>;

export const BulkUploadCreateResponseSchema = z.object({
  upload_id: z.string(),
  upload: z
    .object({
      method: z.enum(['PUT', 'POST']),
      url: z.string(),
      headers: z.record(z.string(), z.string()),
      form_fields: z.record(z.string(), z.string()),
    })
    .optional(),
  upload_url: z.string(),
  s3_key: z.string(),
  expires_at: z.string(),
  content_type: z.string(),
  max_bytes: z.number(),
  schema_id: z.string(),
  schema_version: z.string(),
  status: z.string(),
});
export type BulkUploadCreateResponse = z.infer<typeof BulkUploadCreateResponseSchema>;

/** Row outcome counts of a bulk upload; `total_rows` is null until the file is parsed. */
const UploadRowCountsSchema = OutcomeCountsSchema.omit({ total: true }).extend({
  total_rows: z.number().nullable(),
});

export const BulkUploadStatusSchema = UploadRowCountsSchema.extend({
  upload_id: z.string(),
  status: z.string(),
  status_reason: z.string().nullable(),
  participant_type: z.string(),
  errors_csv_s3_key: z.string().nullable(),
  schema_id: z.string(),
  schema_version: z.string(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});
export type BulkUploadStatus = z.infer<typeof BulkUploadStatusSchema>;

/** Response of `POST /api/bulk-uploads/:id/start`; `duplicate` and `message` are set for a repeat upload. */
export const BulkUploadStartResultSchema = BulkUploadStatusSchema.extend({
  duplicate: z.boolean().optional(),
  message: z.string().optional(),
});
export type BulkUploadStartResult = z.infer<typeof BulkUploadStartResultSchema>;

export const BulkUploadListSchema = z.object({
  items: z.array(BulkUploadStatusSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
export type BulkUploadList = z.infer<typeof BulkUploadListSchema>;

export const BulkUploadErrorsResponseSchema = z.object({
  upload_id: z.string(),
  url: z.string(),
  s3_key: z.string(),
  expires_at: z.string(),
  content_type: z.string(),
  counts: UploadRowCountsSchema,
});
export type BulkUploadErrorsResponse = z.infer<typeof BulkUploadErrorsResponseSchema>;

/** Appends `params` as a query string when there are any. */
function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Thrown when `/start` answered OK with an unreadable body and the upload's
 * status could not be read again either.
 *
 * The upload was started, so the caller must not offer a plain retry: that
 * would upload the same file twice.
 */
export class BulkUploadStartUnreadError extends Error {
  override readonly name = 'BulkUploadStartUnreadError';

  /**
   * @param uploadId - The upload that was started.
   * @param options - The error that stopped the re-read, as `cause`.
   */
  constructor(
    readonly uploadId: string,
    options?: ErrorOptions,
  ) {
    super(`bulk upload ${uploadId} started, but its status could not be read`, options);
  }
}

export const onboardingService = {
  async listLinks(
    opts: {
      domain?: string;
      status?: 'draft' | 'live' | 'retired';
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<ListLinksResponse> {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const data = await jsonFetch(withQuery('/api/links', params), ListLinksResponseSchema);
    if (opts.domain) {
      return { ...data, items: data.items.filter((it) => it.domain === opts.domain) };
    }
    return data;
  },

  async createLink(input: CreateLinkInput): Promise<ApiRegistrationLink> {
    return jsonFetch('/api/links', ApiRegistrationLinkSchema, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateLink(id: string, patch: UpdateLinkInput): Promise<ApiRegistrationLink> {
    return jsonFetch(`/api/links/${encodeURIComponent(id)}`, ApiRegistrationLinkSchema, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async activateLink(id: string): Promise<ApiRegistrationLink> {
    return jsonFetch(`/api/links/${encodeURIComponent(id)}/activate`, ApiRegistrationLinkSchema, {
      method: 'POST',
    });
  },

  async deactivateLink(id: string): Promise<ApiRegistrationLink> {
    return jsonFetch(`/api/links/${encodeURIComponent(id)}/deactivate`, ApiRegistrationLinkSchema, {
      method: 'POST',
    });
  },

  async summary(opts: { from?: string; to?: string } = {}): Promise<OnboardingSummary> {
    const params = new URLSearchParams();
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    return jsonFetch(withQuery('/api/onboarding/summary', params), OnboardingSummarySchema);
  },

  async bySource(opts: { from?: string; to?: string } = {}): Promise<OnboardingBySource> {
    const params = new URLSearchParams();
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    return jsonFetch(withQuery('/api/onboarding/by-source', params), OnboardingBySourceSchema);
  },

  async createBulkUpload(participantType: string): Promise<BulkUploadCreateResponse> {
    return jsonFetch('/api/bulk-uploads', BulkUploadCreateResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ participant_type: participantType }),
    });
  },

  async startBulkUpload(uploadId: string, attestation: boolean): Promise<BulkUploadStartResult> {
    return jsonFetch(
      `/api/bulk-uploads/${encodeURIComponent(uploadId)}/start`,
      BulkUploadStartResultSchema,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attestation }),
      },
    );
  },

  async readBulkUpload(uploadId: string): Promise<BulkUploadStatus> {
    return jsonFetch(`/api/bulk-uploads/${encodeURIComponent(uploadId)}`, BulkUploadStatusSchema);
  },

  async listBulkUploads(opts: { limit?: number; offset?: number } = {}): Promise<BulkUploadList> {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    return jsonFetch(withQuery('/api/bulk-uploads/list', params), BulkUploadListSchema);
  },

  async errorsCsvUrl(uploadId: string): Promise<BulkUploadErrorsResponse> {
    return jsonFetch(
      `/api/bulk-uploads/${encodeURIComponent(uploadId)}/errors`,
      BulkUploadErrorsResponseSchema,
    );
  },

  /**
   * Runs a bulk upload: presign, upload to storage, then start.
   *
   * `duplicate` is true when the file matches a prior upload; the existing run is returned.
   * When `/start` accepts the upload but its reply cannot be read, the status
   * is read again, so the caller does not upload the same file twice.
   *
   * @param file - The CSV file.
   * @param participantType - Domain of the rows.
   * @param attestation - Whether the coordinator accepted the attestation.
   * @returns The upload id and status.
   * @throws {BulkUploadStartUnreadError} If `/start` accepted the upload and its status could not be read.
   * @throws {Error} If the storage upload or an API call fails.
   */
  async uploadCsv(
    file: File,
    participantType: string,
    attestation: boolean,
  ): Promise<{
    uploadId: string;
    status: BulkUploadStatus;
    duplicate?: boolean;
    message?: string;
  }> {
    const presigned = await this.createBulkUpload(participantType);
    await uploadFile(file, presigned);
    let status: BulkUploadStartResult;
    try {
      status = await this.startBulkUpload(presigned.upload_id, attestation);
    } catch (err) {
      if (!(err instanceof ResponseShapeError)) throw err;
      console.error('[bulk-upload] unexpected /start reply; reading the status again', {
        url: err.url,
        issues: err.issueSummary(),
      });
      return {
        uploadId: presigned.upload_id,
        status: await rereadStarted(presigned.upload_id),
      };
    }
    const out: {
      uploadId: string;
      status: BulkUploadStatus;
      duplicate?: boolean;
      message?: string;
    } = {
      uploadId: status.upload_id,
      status,
    };
    if (status.duplicate) out.duplicate = true;
    if (status.message) out.message = status.message;
    return out;
  },
};

/**
 * Sends the file as the api's upload instructions say, or to `upload_url` on older api builds.
 *
 * @param file - The CSV file.
 * @param created - The reservation returned by the api.
 * @throws {Error} If storage answers with a non-2xx status.
 */
async function uploadFile(file: File, created: BulkUploadCreateResponse): Promise<void> {
  const { upload } = created;
  let res: Response;
  if (!upload) {
    res = await fetch(created.upload_url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': created.content_type },
    });
  } else if (upload.method === 'POST') {
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.form_fields)) form.append(name, value);
    form.append('file', file);
    res = await fetch(upload.url, { method: 'POST', body: form, headers: upload.headers });
  } else {
    res = await fetch(upload.url, { method: 'PUT', body: file, headers: upload.headers });
  }
  if (!res.ok) throw new Error(`File upload failed (${res.status})`);
}

/**
 * Reads the status of an upload that `/start` accepted.
 *
 * @param uploadId - The started upload.
 * @returns The upload's status.
 * @throws {BulkUploadStartUnreadError} If the status cannot be read.
 */
async function rereadStarted(uploadId: string): Promise<BulkUploadStatus> {
  try {
    return await onboardingService.readBulkUpload(uploadId);
  } catch (err) {
    throw new BulkUploadStartUnreadError(uploadId, { cause: err });
  }
}
