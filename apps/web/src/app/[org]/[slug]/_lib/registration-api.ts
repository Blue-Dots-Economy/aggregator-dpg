/**
 * Browser calls the public registration page makes to its BFF (web app):
 * the pre-submit identity probe and the registration submit.
 */
import { z } from 'zod';
import type { ErrorSchema } from '@rjsf/utils';
import { readErrorEnvelope, type ErrorEnvelope } from '@/lib/api-error';
import type { LinkIdentity } from '@/lib/registration-link';
import { summariseIssues } from '@/lib/response-shape-error';
import { toErrorSchema } from './field-errors';

/**
 * Outcome of the pre-submit identity probe: submit normally, or the identity
 * belongs to a different aggregator.
 */
export type LookupOutcome = { kind: 'allow' } | { kind: 'owned_elsewhere' };

/** `GET /api/:org/:slug/lookup`: the field the probe reads. */
const LookupResponseSchema = z.object({ owned_elsewhere: z.boolean() });

/**
 * `POST /api/:org/:slug/submit`, both the 201 body and the 409 body.
 * `outcome` is a plain string in the API's contract.
 */
const SubmitResponseSchema = z.object({
  outcome: z.string(),
  submission_id: z.string().optional(),
});

/** Keys read as the email when the network names no email field. */
const FALLBACK_EMAIL_KEY = 'email';

/** Keys read as the phone, in order, when the network names no phone field. */
const FALLBACK_PHONE_KEYS = ['phone', 'phone_number', 'mobile'] as const;

/**
 * Logs the field paths of a response body that does not match its schema.
 *
 * @param url - The request URL.
 * @param body - The parsed body, or `null` when it was not JSON.
 * @param issues - The schema issues.
 */
function logShapeError(url: string, body: unknown, issues: z.ZodIssue[]): void {
  console.error('[public-registration] unexpected response shape', {
    url,
    issues: body === null ? [] : summariseIssues(issues),
  });
}

/**
 * Logs a failed identity probe. The submit still goes ahead.
 *
 * Never log the error message, the reply body or the query: they can hold
 * the participant's email or phone.
 *
 * @param errorType - The error's name, or `HttpError` for an error status.
 * @param httpStatus - The reply's status, when there was a reply.
 */
function logProbeFailure(errorType: string, httpStatus?: number): void {
  console.warn('[public-registration] identity probe failed; submitting without it', {
    operation: 'public-registration.lookup',
    status: 'failure',
    error_type: errorType,
    ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
  });
}

/**
 * BFF path for one of the link's routes.
 *
 * @param org - Organisation slug from the URL.
 * @param slug - Link slug from the URL.
 * @param route - The route under the link.
 */
function linkApiPath(org: string, slug: string, route: 'lookup' | 'submit'): string {
  return `/api/${encodeURIComponent(org)}/${encodeURIComponent(slug)}/${route}`;
}

/**
 * Trimmed string value, or `''` for a blank or non-string value.
 *
 * @param value - A form value.
 */
function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Inputs to {@link probeIdentity}. */
export interface IdentityProbeInput {
  org: string;
  slug: string;
  /** Signalstack network id. An empty string skips the probe. */
  network: string;
  domain: string;
  identity: LinkIdentity | undefined;
  /** Current form values. */
  values: Record<string, unknown>;
}

/**
 * Checks, before submit, whether the email or phone belongs to another aggregator.
 *
 * Returns `allow` when no identity is given, the network is unknown, the
 * BFF errors, or the contact is not owned elsewhere. A contact with profiles
 * under this aggregator is allowed; a participant may have more than one.
 *
 * @param input - Link, identity field names and form values.
 * @returns The outcome the submit branches on.
 */
export async function probeIdentity(input: IdentityProbeInput): Promise<LookupOutcome> {
  const { org, slug, network, domain, identity, values } = input;
  if (!network) return { kind: 'allow' };
  // Read identity using the network's field names, falling back to common keys.
  const email = trimmedString(values[identity?.email ? identity.email : FALLBACK_EMAIL_KEY]);
  const phoneRaw = identity?.phone
    ? values[identity.phone]
    : FALLBACK_PHONE_KEYS.map((key) => values[key]).find((v) => v !== undefined && v !== null);
  const phone = trimmedString(phoneRaw);
  if (!email && !phone) return { kind: 'allow' };
  const qs = new URLSearchParams();
  if (email) qs.set('email', email);
  if (phone) qs.set('phone_number', phone);
  qs.set('network', network);
  qs.set('domain', domain);
  const lookupPath = linkApiPath(org, slug, 'lookup');
  let res: Response;
  try {
    res = await fetch(`${lookupPath}?${qs.toString()}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    // Network error: submit normally; the API handles duplicates.
    logProbeFailure(err instanceof Error ? err.name : typeof err);
    return { kind: 'allow' };
  }
  if (!res.ok) {
    logProbeFailure('HttpError', res.status);
    return { kind: 'allow' };
  }
  // A body that does not match is treated like a failed probe: submit normally.
  const body: unknown = await res.json().catch(() => null);
  const parsed = LookupResponseSchema.safeParse(body);
  if (!parsed.success) {
    logShapeError(lookupPath, body, parsed.error.issues);
    return { kind: 'allow' };
  }
  // Existing profiles under this aggregator (live, draft, or paused) do not
  // block: the submit creates another profile. Signals enforces the profile
  // limit and returns `PROFILE_LIMIT_REACHED`. `lifecycle_summary` is not read.
  return parsed.data.owned_elsewhere ? { kind: 'owned_elsewhere' } : { kind: 'allow' };
}

/** Result of {@link postRegistration}. */
export type SubmitResult =
  | { kind: 'done'; submissionId: string; outcome: 'passed' | 'skipped' }
  | {
      kind: 'rejected';
      status: number;
      error: ErrorEnvelope;
      /** Server field errors mapped onto the form, if any. */
      fieldErrors: ErrorSchema | undefined;
    };

/**
 * Posts a registration to the BFF.
 *
 * A 409 with `outcome: skipped` means the participant is already registered
 * here and counts as done. A 2xx body that does not match still counts as
 * done, without a reference; an error would invite a second submission.
 *
 * @param org - Organisation slug from the URL.
 * @param slug - Link slug from the URL.
 * @param body - The JSON body to send.
 * @returns Done or rejected.
 * @throws {TypeError} When the request fails before a response arrives.
 */
export async function postRegistration(
  org: string,
  slug: string,
  body: Record<string, unknown>,
): Promise<SubmitResult> {
  const submitPath = linkApiPath(org, slug, 'submit');
  const res = await fetch(submitPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const resBody: unknown = await res.json().catch(() => null);
  if (res.status === 409) {
    const dup = SubmitResponseSchema.safeParse(resBody);
    if (dup.success && dup.data.outcome === 'skipped') {
      return { kind: 'done', submissionId: dup.data.submission_id ?? '', outcome: 'skipped' };
    }
  }
  if (!res.ok) {
    const error = readErrorEnvelope(resBody);
    return {
      kind: 'rejected',
      status: res.status,
      error,
      fieldErrors: toErrorSchema(error.fields?.['field_errors']),
    };
  }
  const accepted = SubmitResponseSchema.safeParse(resBody);
  if (!accepted.success) {
    logShapeError(submitPath, resBody, accepted.error.issues);
    return { kind: 'done', submissionId: '', outcome: 'passed' };
  }
  return {
    kind: 'done',
    submissionId: accepted.data.submission_id ?? '',
    outcome: accepted.data.outcome === 'skipped' ? 'skipped' : 'passed',
  };
}
