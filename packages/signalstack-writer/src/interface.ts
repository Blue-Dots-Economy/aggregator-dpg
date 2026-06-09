/**
 * SignalStack writer contract — single boundary for every aggregator path that
 * pushes a participant + optional profile to a signalstack instance through
 * `POST /api/v1/admin/onboard`.
 *
 * The local `participants` table is written by `@aggregator-dpg/participants-writer`.
 * This writer is the parallel "outward" wrapper: every place that decides a
 * participant should be reflected into signalstack calls this single method.
 *
 * Every method returns Result<T, BaseError> — never throws.
 */

import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

/**
 * Channel attribution for a participant onboard call. Signalstack uses this
 * to attribute the inbound row to the originating workflow:
 *   - `bulk` — CSV upload processed by the worker; `source_id` is the
 *      `bulk_uploads.id` row.
 *   - `link` — public registration link submission; `source_id` is the
 *      `registration_links.id` row.
 */
export type SignalStackOnboardChannel = 'bulk' | 'link';

/**
 * Echo of one profile row stored in signalstack's `items` table. Returned
 * by the `listItemsByAggregator` read endpoint (the participant onboard
 * endpoint returns the slimmer {@link SignalStackOnboardParticipantResult}
 * shape).
 */
export interface SignalStackProfile {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, unknown>;
  item_latitude: number | null;
  item_longitude: number | null;
  aggregator_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Input for one participant onboard call to signalstack.
 *
 * Mirrors the flat body shape signalstack expects on
 * `POST /api/v1/admin/participant`. The `actingOrgId` is sent as
 * the per-call `x-acting-org-id` header — it is the aggregator's own
 * signalstack organisation id (sourced from `aggregators.signalstack_org_id`),
 * NOT the platform-wide acting org id used by aggregator upsert.
 */
export interface SignalStackOnboardParticipantInput {
  /** Signalstack organisation id the participant is being linked under. */
  actingOrgId: string;
  /** Display name of the participant; falls back to participant UUID upstream. */
  name: string;
  /** Phone number (E.164) — at least one of phoneNumber / email is required. */
  phoneNumber?: string;
  /** Email address — at least one of phoneNumber / email is required. */
  email?: string;
  /** Whether the participant has accepted the aggregator's T&C. */
  terms_accepted: boolean;
  /** Whether the participant has accepted the aggregator's privacy policy. */
  privacy_accepted: boolean;
  /** Channel attribution — distinguishes bulk-upload from link submission. */
  channel: SignalStackOnboardChannel;
  /**
   * Originating workflow row id. `bulk_uploads.id` when channel = `bulk`,
   * `registration_links.id` when channel = `link`. Signalstack stores this
   * verbatim for audit and dedupe.
   */
  source_id: string;
  /** `blue_dot` etc — partition the row lands under. */
  network: string;
  /** `seeker` | `provider` — participant focus. */
  domain: string;
  /** `profile_1.0` (seeker) | `job_posting_1.0` (provider) — schema version tag. */
  item_type: string;
  /** Free-form item_state payload — the participant's profile fields. */
  profile: Record<string, unknown>;
}

/**
 * Response payload from `POST /api/v1/admin/participant`.
 *
 * Slim shape: signalstack returns only the identifiers it minted plus the
 * server-side timestamp. The caller's audit log captures this verbatim;
 * `listItemsByAggregator` is the canonical read path for the full row.
 */
export interface SignalStackOnboardParticipantResult {
  user_id: string;
  profile_item_id: string;
  onboarded_at: string;
  /**
   * True when the user already exists in signalstack under a different
   * aggregator (signalstack returns `user_existed: true` with an empty
   * `items` array — that org's items are invisible to this one). The
   * caller should treat this as a `skipped` outcome, not an error:
   * `profile_item_id` is empty because no item was created or returned.
   */
  already_registered?: boolean;
}

/**
 * Filter for the aggregator-scoped read of signalstack items.
 *
 * `item_network` + `item_domain` are required so signalstack can look up the
 * right partition; `aggregator_id` is the dashboard's primary scope; the
 * rest are pagination + optional refinement.
 */
export interface SignalStackItemQuery {
  aggregator_id: string;
  item_network: string;
  item_domain: string;
  item_type?: string;
  limit?: number;
  offset?: number;
}

/**
 * Paginated meta block returned alongside the items list.
 */
export interface SignalStackItemListMeta {
  total: number;
  limit: number;
  offset: number;
}

/**
 * Response shape for the aggregator-scoped read.
 */
export interface SignalStackItemList {
  meta: SignalStackItemListMeta;
  items: SignalStackProfile[];
}

/**
 * Input for the admin aggregator upsert call.
 *
 * `external_id` is our Postgres `aggregators.id` — signalstack stores it
 * verbatim and uses it as the dedupe key. Calling upsert again with the
 * same `external_id` returns the existing row instead of creating a new
 * one, so the writer is safe to re-fire from a login-time fallback.
 */
export interface SignalStackUpsertAggregatorInput {
  external_id: string;
  name: string;
  slug: string;
  /**
   * Signalstack domain ids this aggregator org participates in
   * (`seeker`, `provider`, …). Stored on the org record and gates the
   * dashboard endpoint — `NO_DOMAINS_CONFIGURED` is returned when the
   * array is empty. Should be the full list of domains declared by the
   * active signalstack network.
   */
  domains?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Echo of the signalstack `aggregators` row resolved by the upsert call.
 *
 * `org_id` is the canonical signalstack organisation identifier — the
 * value the aggregator API stores on the Keycloak user as
 * `signalstack_org_id`. Surfaced as the access-token claim of the same
 * name so route handlers can scope reads/writes against signalstack
 * without an extra round-trip.
 */
export interface SignalStackAggregator {
  org_id: string;
  external_id: string;
  name: string;
  slug: string;
  metadata?: Record<string, unknown>;
}

/**
 * Query parameters for the aggregator dashboard read.
 *
 * `actingOrgId` becomes the per-call `x-acting-org-id` header. `status` is
 * forwarded verbatim — signalstack is the source of truth for the allowed
 * set (`new`, `at_risk`, `accepted`, etc.), so the writer doesn't pin an
 * enum that would drift. `domain` is reserved for the eventual
 * provider rollout; signalstack currently scopes by aggregator only, so
 * the HTTP impl drops the field today and threads it through unchanged
 * when upstream support lands.
 */
export interface SignalStackDashboardQuery {
  actingOrgId: string;
  page?: number;
  limit?: number;
  status?: string;
  domain?: string;
  /**
   * When true, forwards `?refresh=true` to signalstack so it bypasses the
   * TTL cache and recomputes the rollup synchronously. Off by default.
   */
  refresh?: boolean;
}

/**
 * Pre-computed rollup of participant + action counts returned per domain.
 *
 * `by_status` and the directional action maps use partial maps because
 * signalstack may omit a bucket when its count is zero; consumers default
 * missing keys to 0. `mode_wise_counts` is open-shape — signalstack adds keys
 * for any `onboarded_via` value the aggregator emits.
 */
export interface SignalStackDashboardRollup {
  total_items: number;
  complete_profiles: number;
  has_applications: number;
  by_status: Partial<Record<'new' | 'active' | 'at_risk' | 'inactive', number>>;
  /** Actions this domain's profiles INITIATED, by action state. */
  by_initiated_action_status: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', number>>;
  /** Actions this domain's profiles RECEIVED, by action state. */
  by_received_action_status: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', number>>;
  /** Distinct users (one user may own many profiles). */
  total_users: number;
  avg_items_per_user: number;
  avg_actions_per_user: number;
  mode_wise_counts: Record<string, number>;
}

/**
 * One domain slice of the dashboard response. Carries the rollup +
 * paginated items list scoped to that domain id.
 */
export interface SignalStackDashboardDomainSlice {
  rollup: SignalStackDashboardRollup;
  /**
   * One row per profile. Open-shape because signalstack owns the per-row
   * schema; consumers decode the keys they care about (today:
   * profile_item_id, user_id, name, item_network, item_type, onboarded_via,
   * profile_status, profile_completion_pct, profile_created_at,
   * profile_last_updated_at, age_days, initiated, received,
   * last_initiated_at, last_received_at, actionable_tags). `initiated` /
   * `received` are full `{create,accept,reject,cancel}` count maps;
   * `last_initiated_at` / `last_received_at` are sparse maps (only buckets
   * that occurred carry an ISO timestamp).
   */
  items: Array<Record<string, unknown>>;
  total_matching: number;
  next_cursor: string | null;
}

/**
 * Signalstack-side metadata about the cached rollup. `refreshed=true`
 * means signalstack just recomputed; `false` means the response came
 * from cache within the `ttl_seconds` window. Surfaced verbatim so the
 * dashboard can show a "last updated" hint.
 */
export interface SignalStackDashboardMetadata {
  last_computed_at: string;
  ttl_seconds: number;
  refreshed: boolean;
}

/**
 * Full payload returned by `GET /api/v1/aggregator/dashboard`.
 *
 * Signalstack returns every served domain (seeker, provider, …) in a
 * single response keyed by `by_domain[<id>]`. The aggregator surfaces
 * the whole map so the dashboard can render seeker + provider tabs in
 * one render without a second round-trip.
 */
export interface SignalStackDashboardPage {
  by_domain: Record<string, SignalStackDashboardDomainSlice>;
  metadata: SignalStackDashboardMetadata;
}

/**
 * Query parameters for the aggregator dashboard CSV export.
 *
 * Same `actingOrgId` semantics as the JSON dashboard read. `status` is
 * the only filter accepted by the upstream `?status=…` query today;
 * `domain` is reserved for the eventual provider rollout and the HTTP
 * impl currently drops it.
 */
export interface SignalStackDashboardExportQuery {
  actingOrgId: string;
  status?: string;
  domain?: string;
  /** Same semantics as on the dashboard query — bypass TTL, force recompute. */
  refresh?: boolean;
}

/**
 * Result payload for the dashboard CSV export.
 *
 * `csv` is the raw `text/csv; charset=utf-8` body returned by signalstack.
 * Callers stream it back to the requesting browser verbatim — we do not
 * decode or rewrite the rows. `filename` is a sensible default derived
 * from the status filter and current date; the API route may override.
 */
export interface SignalStackDashboardExport {
  csv: string;
  filename: string;
}

/**
 * Persistence port for the signalstack admin endpoints.
 *
 * Implementations:
 *   - Http: real fetch-backed adapter — calls
 *     `POST /api/v1/admin/participant`,
 *     `POST /api/v1/admin/aggregator/upsert`, and
 *     `POST /api/v1/network/item/fetch_local`.
 *   - InMemory: deterministic Map-backed impl for unit tests.
 *   - Fake: in-memory + `seed()` helper for cross-package consumer tests.
 */
export abstract class SignalStackWriterBase {
  /**
   * Onboard one participant under an aggregator's signalstack organisation.
   *
   * Calls `POST /api/v1/admin/participant` with the per-call
   * `x-acting-org-id: {input.actingOrgId}` header so signalstack scopes the
   * write to the calling aggregator. The endpoint creates (or finds) the
   * user by phone/email and writes the profile row in one round-trip.
   *
   * @param input - Flat participant payload + actingOrgId + channel/source.
   * @returns ok(SignalStackOnboardParticipantResult) on 2xx; err(BaseError)
   *   on transport failure, validation rejection, or any non-2xx response.
   */
  abstract onboard(
    input: SignalStackOnboardParticipantInput,
  ): Promise<Result<SignalStackOnboardParticipantResult, BaseError>>;

  /**
   * Read all items signalstack has stored for the given aggregator_id
   * within a single (item_network, item_domain[, item_type]) scope.
   *
   * @param query - Aggregator + network/domain scope + optional pagination.
   * @returns ok(SignalStackItemList) on 2xx; err(BaseError) otherwise.
   */
  abstract listItemsByAggregator(
    query: SignalStackItemQuery,
  ): Promise<Result<SignalStackItemList, BaseError>>;

  /**
   * Register (or look up) the aggregator's organisation row in signalstack.
   *
   * Idempotent on `external_id`: repeated calls with the same input return
   * the same `org_id` and never create duplicates. Called once at admin
   * approval, and again as a login-time fallback if the Keycloak attribute
   * is missing.
   *
   * @param input - external_id (our aggregator UUID) + display name + slug.
   * @returns ok(SignalStackAggregator) on 2xx; err(BaseError) otherwise.
   */
  abstract upsertAggregator(
    input: SignalStackUpsertAggregatorInput,
  ): Promise<Result<SignalStackAggregator, BaseError>>;

  /**
   * Fetch the aggregator dashboard rollup + paginated participant list.
   *
   * Calls `GET /api/v1/aggregator/dashboard` with the per-call
   * `x-acting-org-id: {query.actingOrgId}` header. Signalstack caches the
   * rollup per aggregator and refreshes on the TTL declared in the
   * response `metadata.ttl_seconds` field; the writer returns whatever
   * signalstack hands back without further interpretation.
   *
   * @param query - actingOrgId + optional page/limit/status/domain.
   * @returns ok(SignalStackDashboardPage) on 2xx; err(BaseError) on
   *   transport failure, validation rejection, or non-2xx.
   */
  abstract fetchDashboard(
    query: SignalStackDashboardQuery,
  ): Promise<Result<SignalStackDashboardPage, BaseError>>;

  /**
   * Export the aggregator dashboard as a CSV file.
   *
   * Calls `GET /api/v1/aggregator/dashboard/export` with the per-call
   * `x-acting-org-id: {query.actingOrgId}` and `accept: text/csv` so
   * signalstack returns the raw CSV body. The writer hands the body
   * back as-is — the route streams it to the browser with a
   * `Content-Disposition: attachment` header.
   *
   * @param query - actingOrgId + optional status/domain filter.
   * @returns ok(SignalStackDashboardExport) on 2xx; err(BaseError) on
   *   transport failure, validation rejection, or non-2xx.
   */
  abstract exportDashboardCsv(
    query: SignalStackDashboardExportQuery,
  ): Promise<Result<SignalStackDashboardExport, BaseError>>;
}
