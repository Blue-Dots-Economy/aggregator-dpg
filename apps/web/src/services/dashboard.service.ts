/**
 * Blue-dots dashboard service.
 *
 * Reads the signalstack-backed aggregator dashboard (rollup + participant
 * rows) via the BFF proxy. Every read here is org-scoped upstream by
 * signalstack from the caller's acting-org, so the service does no
 * ownership filtering of its own.
 */

import { jsonFetch } from './http';

/**
 * Query for the signalstack-backed aggregator dashboard.
 *
 * `status` is intentionally optional — the dashboard's default render
 * issues the call WITHOUT a status param so the rollup returns full
 * by-status counts and the participants list is unfiltered. The page
 * refetches with `status` set only when the user explicitly picks a
 * server-side filter chip.
 */
export interface DashboardQuery {
  domain?: string;
  page?: number;
  limit?: number;
  status?: string;
  /**
   * Server-side lifecycle filter for the participant list. `'draft'` / `'live'`
   * narrow the fetched (and paginated) rows to that lifecycle upstream; omit
   * (the `'all'` case) to get the default draft+live set. Filtering server-side
   * — not client-side over a page — is what lets a rare draft surface when the
   * domain is dominated by live profiles.
   */
  lifecycle?: 'draft' | 'live';
  /**
   * When true, the BFF forwards `?refresh=true` to signalstack to bypass
   * the rollup TTL and recompute synchronously. The page sets this only
   * for explicit user-initiated refreshes — passing it on every fetch
   * would defeat caching.
   */
  refresh?: boolean;
}

/**
 * Pre-computed rollup of participant + action counts returned per domain.
 * `by_status` and the directional action maps use open `Record<string, number>`
 * so the page maps fixed keys with `?? 0` fallbacks defensively.
 */
export interface DashboardRollup {
  total_items: number;
  complete_profiles: number;
  has_applications: number;
  by_status: Record<string, number>;
  by_initiated_action_status: Record<string, number>;
  by_received_action_status: Record<string, number>;
  total_users: number;
  avg_items_per_user: number;
  avg_actions_per_user: number;
  mode_wise_counts: Record<string, number>;
}

/**
 * Per-domain slice of the dashboard payload. Carries the rollup +
 * paginated items list scoped to that domain id.
 */
export interface DashboardDomainSlice {
  rollup: DashboardRollup;
  /** One row per item — `participants` was the old name. */
  items: Array<Record<string, unknown>>;
  total_matching: number;
  next_cursor: string | null;
}

/**
 * Signalstack-side metadata about the cached rollup. Surfaced verbatim
 * so the dashboard can display a "last updated" hint and decide whether
 * the response is fresh or cache-served.
 */
export interface DashboardMetadata {
  last_computed_at: string;
  ttl_seconds: number;
  refreshed: boolean;
}

/**
 * Full payload of the dashboard fetch. Signalstack returns every
 * served domain (seeker, provider, …) in a single response keyed by
 * `by_domain[<id>]` — the dashboard renders all tabs from one fetch.
 */
export interface DashboardPage {
  by_domain: Record<string, DashboardDomainSlice>;
  metadata: DashboardMetadata;
}

/**
 * Lifecycle bucket a dashboard row can sit in.
 *
 * Forwarded as the `?lifecycle=` filter on the dashboard read, and narrowed
 * to what the UI actually offers by `LifecycleFilterValue` on the dashboard
 * page — `paused` and `account_only` are accepted by the API but not
 * surfaced in the dropdown today.
 */
export type LifecycleFilter = 'draft' | 'live' | 'paused' | 'account_only';

/**
 * Query for the dashboard CSV export. Subset of {@link DashboardQuery}
 * because signalstack's `/dashboard/export` endpoint accepts only
 * `status` as a filter today.
 */
export interface DashboardExportQuery {
  domain?: string;
  status?: string;
}

/**
 * Outcome of a dashboard CSV download. `blob` is the raw CSV payload
 * for callers that want to render a preview or post-process. `filename`
 * comes from the BFF's `Content-Disposition` header (falling back to a
 * sensible default) so the browser's save dialog gets the same name
 * signalstack minted.
 */
export interface DashboardExportResult {
  blob: Blob;
  filename: string;
  /**
   * Requested rows the API withheld, from `X-Export-Skipped-Count`.
   *
   * Only the decrypted-profile export sets this: the API drops item_ids that
   * are not this aggregator's rather than rejecting the request, so a caller
   * that selected N rows can receive fewer and needs to say so. `undefined`
   * when the header is absent (any other export).
   */
  skippedCount?: number;
}

/**
 * Server-side bulk action request for a set of selected dashboard rows.
 * `action` names the operation (validated against the BFF's allowlist);
 * `ids` are the selected rows' item ids.
 */
export interface DashboardBulkActionInput {
  action: string;
  domain: string;
  ids: string[];
}

/** Acknowledgement from the bulk-action endpoint (202 envelope). */
export interface DashboardBulkActionResult {
  accepted: number;
}

export interface DashboardService {
  /**
   * Fetch the signalstack-backed aggregator dashboard payload.
   *
   * Call without `status` for the default landing view (full rollup +
   * unfiltered participants); call again with `status` set when the
   * user selects a filter chip so signalstack returns the server-side
   * filtered slice.
   */
  dashboard(query?: DashboardQuery): Promise<DashboardPage>;
  /**
   * Download the dashboard as a CSV file.
   *
   * Returns the Blob + the upstream filename so the caller can either
   * trigger an automatic browser download via {@link triggerCsvDownload}
   * or render a preview. CSV columns are owned by signalstack — the
   * service does not parse, validate, or rewrite them.
   */
  dashboardExport(query?: DashboardExportQuery): Promise<DashboardExportResult>;
  /**
   * Submit a server-side bulk action (e.g. `trigger_callback`) for the
   * selected row ids.
   *
   * The BFF validates the action name against its allowlist and returns
   * a 202 acknowledgement; delivery is asynchronous (stubbed today).
   */
  dashboardBulkAction(input: DashboardBulkActionInput): Promise<DashboardBulkActionResult>;
  /**
   * Download decrypted profile data for the selected item ids as a CSV file.
   *
   * Posts the item ids and domain to the BFF relay which forwards to the
   * aggregator API (which holds the signalstack admin key). Returns the
   * Blob + the upstream filename so the caller can trigger a browser download,
   * plus `skippedCount` when the API reported withholding rows — ids that are
   * not this aggregator's are dropped from the CSV rather than rejected, so a
   * caller that selected N rows may receive fewer and should say so.
   */
  dashboardExportProfiles(input: {
    domain: string;
    itemIds: string[];
  }): Promise<DashboardExportResult>;
}

class HttpDashboardService implements DashboardService {
  async dashboard(query?: DashboardQuery): Promise<DashboardPage> {
    const params = new URLSearchParams();
    // Domain is required by signalstack and must be a valid network domain
    // id. Callers (Seekers/ProvidersTab) read this from
    // cfg.domains[N].id — no static default here so the request fails
    // loudly if the caller forgets, instead of silently going 'seeker'
    // against networks that don't declare it (e.g. orange_dot).
    if (!query?.domain) throw new Error('dashboard query requires `domain`');
    params.set('domain', query.domain);
    if (query?.page !== undefined) params.set('page', String(query.page));
    if (query?.limit !== undefined) params.set('limit', String(query.limit));
    // Skip `status` when the caller did not select a filter chip — the
    // default landing render needs the full rollup + unfiltered list, so
    // the BFF/API must NOT see a `status` param in that mode.
    if (query?.status) params.set('status', query.status);
    if (query?.lifecycle) params.set('lifecycle', query.lifecycle);
    if (query?.refresh) params.set('refresh', 'true');
    const url = `/api/dashboard?${params.toString()}`;
    return jsonFetch<DashboardPage>(url);
  }

  async dashboardExport(query?: DashboardExportQuery): Promise<DashboardExportResult> {
    const params = new URLSearchParams();
    if (!query?.domain) throw new Error('dashboardExport query requires `domain`');
    params.set('domain', query.domain);
    if (query?.status) params.set('status', query.status);
    const url = `/api/dashboard/export?${params.toString()}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/csv' },
      credentials: 'same-origin',
    });
    if (!res.ok) {
      // Error envelope is JSON; surface the upstream message so the
      // caller's toast can show something more useful than "fetch failed".
      let message = `dashboard export failed: ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { detail?: string; message?: string } };
        const detail = body?.error?.detail ?? body?.error?.message;
        if (detail) message = detail;
      } catch {
        // non-JSON body — keep the default message.
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename =
      parseFilenameFromContentDisposition(disposition) ?? defaultExportFilename(query);
    return { blob, filename };
  }

  async dashboardExportProfiles(input: {
    domain: string;
    itemIds: string[];
  }): Promise<DashboardExportResult> {
    if (!input.domain) throw new Error('dashboardExportProfiles requires `domain`');
    if (!input.itemIds.length)
      throw new Error('dashboardExportProfiles requires at least one item id');
    const res = await fetch('/api/dashboard/export/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/csv' },
      credentials: 'same-origin',
      body: JSON.stringify({ item_ids: input.itemIds, domain: input.domain }),
    });
    if (!res.ok) {
      // Error envelope is JSON; surface the upstream message so the
      // caller's toast can show something more useful than "fetch failed".
      let message = `profile export failed: ${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: { detail?: string; message?: string } };
        const detail = errBody?.error?.detail ?? errBody?.error?.message;
        if (detail) message = detail;
      } catch {
        // non-JSON body — keep the default message.
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename =
      parseFilenameFromContentDisposition(disposition) ?? `profiles-${input.domain}.csv`;
    // Absent header, or a non-numeric one, means "no count available" rather
    // than zero — the caller must not report "0 withheld" it did not measure.
    // `Number` coerces both `null` (absent header) and `''` (present but empty)
    // to 0, not NaN, so neither can be fed to it directly — either would be
    // reported as a measured zero by every export that sends no count.
    const rawHeader = res.headers.get('x-export-skipped-count')?.trim();
    const rawSkipped = rawHeader ? Number(rawHeader) : Number.NaN;
    const skippedCount = Number.isInteger(rawSkipped) && rawSkipped >= 0 ? rawSkipped : undefined;
    return { blob, filename, ...(skippedCount === undefined ? {} : { skippedCount }) };
  }

  async dashboardBulkAction(input: DashboardBulkActionInput): Promise<DashboardBulkActionResult> {
    if (!input.action) throw new Error('dashboardBulkAction requires `action`');
    if (!input.domain) throw new Error('dashboardBulkAction requires `domain`');
    if (input.ids.length === 0) throw new Error('dashboardBulkAction requires at least one id');
    const res = await fetch('/api/dashboard/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      let message = `bulk action failed: ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { detail?: string; message?: string } };
        const detail = body?.error?.detail ?? body?.error?.message;
        if (detail) message = detail;
      } catch {
        // non-JSON body — keep the default message.
      }
      throw new Error(message);
    }
    return (await res.json()) as DashboardBulkActionResult;
  }
}
export const dashboardService: DashboardService = new HttpDashboardService();

/**
 * Triggers a browser download for a CSV blob.
 *
 * Creates a transient `<a>` element, points it at an object URL for the
 * blob, clicks it, and revokes the URL. Browser-only; no-op when called
 * during SSR.
 */
export function triggerCsvDownload(result: DashboardExportResult): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Reads the RFC 6266 `filename*=charset'lang'value` parameter.
 *
 * Located by index rather than one `filename\*\s*=\s*[^']*''([^;]+)` regex:
 * the header is upstream-controlled, and that pattern rescans `[^']*` from
 * every start offset when the `''` never arrives — super-linear on a hostile
 * header (SonarCloud typescript:S8786). Each step here is a single scan.
 *
 * @param header - The raw `Content-Disposition` header value.
 * @returns The decoded filename, or `null` when the parameter is absent,
 *   truncated, or not valid percent-encoding.
 */
function parseEncodedFilename(header: string): string | null {
  const starKey = /filename\*\s*=/i.exec(header);
  if (!starKey) return null;

  const afterKey = header.slice(starKey.index + starKey[0].length);
  const quoted = afterKey.indexOf("''");
  if (quoted === -1) return null;

  const rest = afterKey.slice(quoted + 2);
  const end = rest.indexOf(';');
  const value = (end === -1 ? rest : rest.slice(0, end)).trim();
  if (!value) return null;

  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding — the caller falls back to the plain form.
    return null;
  }
}

/**
 * Extracts the filename from a `Content-Disposition` header. Returns
 * null if the header is absent or malformed so the caller can apply a
 * default.
 */
function parseFilenameFromContentDisposition(header: string): string | null {
  if (!header) return null;
  // RFC 6266: prefer the encoded `filename*` form when present, falling
  // back to plain `filename=` for ASCII-only values.
  const encoded = parseEncodedFilename(header);
  if (encoded !== null) return encoded;
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain && plain[1] ? plain[1].trim() : null;
}

/**
 * Last-resort filename used when the BFF didn't supply a
 * `Content-Disposition`. Mirrors the API's default shape so file-save
 * dialogs stay consistent across success paths.
 */
function defaultExportFilename(query?: DashboardExportQuery): string {
  const status = (query?.status ?? 'all').replace(/[^a-z0-9_]/gi, '_').slice(0, 32);
  const date = new Date().toISOString().slice(0, 10);
  return `aggregator-dashboard-${status}-${date}.csv`;
}
