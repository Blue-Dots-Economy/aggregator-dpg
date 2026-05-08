/**
 * Central error code catalogue.
 *
 * Every domain-specific failure has one entry here. Routes throw
 * `httpError(ERR.<KEY>)` and the global error handler renders the canonical
 * envelope. Adding a new error = adding a row here.
 *
 * Layered fields per code:
 *   - `code`     machine identifier surfaced in API response and logs
 *   - `status`   HTTP status the handler returns
 *   - `title`    short human-readable headline shown in the UI
 *   - `detail`   fuller user-facing sentence shown in API response body
 *   - `hint`     internal/dev-facing context for debugging — logs only
 *   - `docs`     optional link to runbook or self-service page
 */

export interface ErrorCatalogueEntry {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly hint: string;
  readonly docs?: string;
}

export const ERR = {
  // ── Generic ─────────────────────────────────────────────────────────────
  INTERNAL: {
    code: 'INTERNAL',
    status: 500,
    title: 'Something went wrong',
    detail: 'The server hit an unexpected error. Please try again.',
    hint: 'Unhandled exception reached the global error handler. Check stack.',
  },
  SCHEMA_VALIDATION: {
    code: 'SCHEMA_VALIDATION',
    status: 400,
    title: 'Invalid input',
    detail: 'One or more fields failed validation.',
    hint: 'Zod or Ajv rejected the request body. See response.error.fields for offending paths.',
  },
  BAD_JSON: {
    code: 'BAD_JSON',
    status: 400,
    title: 'Invalid request',
    detail: 'Request body is not valid JSON.',
    hint: 'Fastify body parser threw. Check Content-Type and body bytes.',
  },

  // ── Auth ────────────────────────────────────────────────────────────────
  UNAUTHORIZED: {
    code: 'UNAUTHORIZED',
    status: 401,
    title: 'Sign-in required',
    detail: 'Your session is missing or invalid. Please sign in again.',
    hint: 'Bearer token absent, malformed, or signature/issuer/exp check failed.',
  },
  FORBIDDEN: {
    code: 'FORBIDDEN',
    status: 403,
    title: 'Access denied',
    detail: 'You do not have permission to perform this action.',
    hint: 'JWT aggregator_id claim does not match path id, or role missing.',
  },

  // ── Registration ────────────────────────────────────────────────────────
  USER_EXISTS: {
    code: 'USER_EXISTS',
    status: 409,
    title: 'Email already registered',
    detail: 'An account with this email already exists. Use a different email or sign in instead.',
    hint: 'Pre-check at idp.findByEmail returned non-null. Stale or duplicate KC user.',
  },
  PHONE_EXISTS: {
    code: 'PHONE_EXISTS',
    status: 409,
    title: 'Phone already registered',
    detail:
      'A user with this mobile number already exists. Use a different number or sign in instead.',
    hint: 'idp.findByAttribute(phoneNumber) returned non-null. Phone is OTP login key — must be unique.',
  },
  INVALID_PHONE: {
    code: 'INVALID_PHONE',
    status: 400,
    title: 'Invalid phone number',
    detail: 'The phone number format is not recognised. Include country code, e.g. +91…',
    hint: 'normalisePhone() failed E.164 parse. Check libphonenumber output.',
  },

  // ── IDP (Keycloak) ──────────────────────────────────────────────────────
  IDP_UNAVAILABLE: {
    code: 'IDP_UNAVAILABLE',
    status: 503,
    title: 'Identity service unavailable',
    detail: 'The identity service is temporarily unreachable. Please try again shortly.',
    hint: 'Keycloak admin API call failed (network/timeout/5xx). Check KC pod + admin creds.',
  },

  // ── Persistence ─────────────────────────────────────────────────────────
  DB_UNAVAILABLE: {
    code: 'DB_UNAVAILABLE',
    status: 503,
    title: 'Service temporarily unavailable',
    detail: 'A backend service is offline. Please retry in a few moments.',
    hint: 'Postgres write failed (connection/constraint/timeout). Check DB pod + slug retries.',
  },
  DUPLICATE_SLUG: {
    code: 'DUPLICATE_SLUG',
    status: 503,
    title: 'Service temporarily unavailable',
    detail: 'Could not allocate a unique identifier for your organisation. Please retry.',
    hint: 'slugWithSuffix collisions exhausted SLUG_RETRIES. Increase entropy or retries.',
  },

  // ── Mail / approval token ───────────────────────────────────────────────
  TOKEN_MINT_FAILED: {
    code: 'TOKEN_MINT_FAILED',
    status: 500,
    title: 'Could not finalise registration',
    detail:
      'We saved your details but failed to issue an approval link. An admin can still process the request.',
    hint: 'mintApprovalToken() threw. Check JWT signing key + jose library.',
  },
  MAIL_FAILED: {
    code: 'MAIL_FAILED',
    status: 500,
    title: 'Email delivery failed',
    detail: 'We could not send the email. Please contact support.',
    hint: 'mailer.send returned non-ok. Check SMTP config + provider response.',
  },

  // ── Approval flow ───────────────────────────────────────────────────────
  APPROVAL_TOKEN_INVALID: {
    code: 'APPROVAL_TOKEN_INVALID',
    status: 400,
    title: 'Invalid approval link',
    detail: 'This approval link is malformed or has been tampered with.',
    hint: 'JWT verification failed. Check signing key rotation.',
  },
  APPROVAL_TOKEN_EXPIRED: {
    code: 'APPROVAL_TOKEN_EXPIRED',
    status: 410,
    title: 'Approval link expired',
    detail: 'This approval link has expired. Ask the applicant to resubmit.',
    hint: 'JWT exp in past. TTL is 1h.',
  },
  APPROVAL_TOKEN_USED: {
    code: 'APPROVAL_TOKEN_USED',
    status: 409,
    title: 'Already processed',
    detail: 'This registration has already been approved or rejected.',
    hint: 'Decision row exists. Single-use token replayed.',
  },

  // ── Generic resource ────────────────────────────────────────────────────
  NOT_FOUND: {
    code: 'NOT_FOUND',
    status: 404,
    title: 'Not found',
    detail: 'The requested resource does not exist.',
    hint: 'Store returned null for the given id.',
  },

  // ── Bulk uploads ────────────────────────────────────────────────────────
  BULK_UPLOAD_NOT_READY: {
    code: 'BULK_UPLOAD_NOT_READY',
    status: 410,
    title: 'Errors report not ready',
    detail: 'The errors report is only available after the upload finishes processing.',
    hint: 'GET /errors.csv called before bulk_uploads.status reached completed.',
  },

  // ── Registration links (public path) ────────────────────────────────────
  LINK_NOT_LIVE: {
    code: 'LINK_NOT_LIVE',
    status: 410,
    title: 'Registration link no longer active',
    detail: 'This registration link is not accepting submissions.',
    hint: 'registration_link.status is retired or expired.',
  },
  LINK_DUPLICATE: {
    code: 'LINK_DUPLICATE',
    status: 409,
    title: 'Already registered',
    detail: 'This participant has already registered with this aggregator.',
    hint: 'participants UNIQUE (aggregator_id, participant_id) — ON CONFLICT path.',
  },
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    status: 429,
    title: 'Too many requests',
    detail: 'You have made too many requests. Please slow down and retry shortly.',
    hint: 'Per-slug+ip rate limiter on public submit; window/max in config.',
  },
} as const satisfies Record<string, ErrorCatalogueEntry>;

export type ErrorCode = keyof typeof ERR;
