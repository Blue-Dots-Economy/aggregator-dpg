/**
 * Canonical Keycloak user-attribute names used across the Aggregator API.
 *
 * Centralised so a typo in one call site can't silently desynchronise the
 * data we read with the data we write.
 *
 * The bare-string values match the keys configured in the Keycloak realm
 * (`infra/keycloak/realms/aggregator-realm.json`) and any custom protocol
 * mappers that publish them as access-token claims.
 */

/**
 * Keycloak carries five attributes:
 *
 *   - `aggregator_id`      — reverse pointer to Postgres
 *   - `aggregator_type`    — `seeker` | `provider`, drives single-type enforcement
 *   - `phoneNumber`        — read by the OTP login authenticator
 *   - `decision_made`      — gates login at the auth middleware
 *   - `signalstack_org_id` — signalstack organisation id written after the
 *                            admin-approval upsert; surfaced as an access-
 *                            token claim so route handlers can scope reads
 *                            against signalstack without an extra round-trip
 *
 * Everything else (org_slug, name, contact details, decision metadata,
 * rejection reason, etc.) lives in Postgres. The deprecated constants below
 * remain so existing realm exports and any in-flight reads do not blow up
 * mid-migration; new code MUST NOT write them.
 */
export const KC_ATTR = {
  /** Postgres aggregator UUID — reverse pointer from KC to our DB. */
  AGGREGATOR_ID: 'aggregator_id',
  /**
   * `seeker` or `provider`. Set at signup, used by the API to enforce that
   * an aggregator only operates on its registered participant type
   * (bulk uploads + public registration links).
   */
  AGGREGATOR_TYPE: 'aggregator_type',
  /** Applicant phone in E.164. Read by the OTP login authenticator. */
  PHONE_NUMBER: 'phoneNumber',
  /** `pending` / `approved` / `rejected` — the login gate. */
  DECISION_MADE: 'decision_made',
  /**
   * Signalstack organisation id assigned by the `POST /admin/aggregator/upsert`
   * call. Written by the aggregator-approval route after the admin approves,
   * and backfilled by the login-time fallback when missing.
   */
  SIGNALSTACK_ORG_ID: 'signalstack_org_id',

  // ─── Deprecated (do not write from new code) ────────────────────────────
  /** @deprecated Slug lives in Postgres (`aggregators.org_slug`). */
  ORG_SLUG: 'org_slug',
  /** @deprecated Display name lives in Postgres (`aggregators.name`). */
  ASSOCIATION: 'association',
  /** @deprecated Decision timestamp lives in Postgres (Phase 8 column). */
  DECIDED_AT: 'decided_at',
  /** @deprecated Rejection reason lives in Postgres (Phase 8 column). */
  REJECTION_REASON: 'rejection_reason',
} as const;

export type KcAttrName = (typeof KC_ATTR)[keyof typeof KC_ATTR];

/** Decision values written to / read from `KC_ATTR.DECISION_MADE`. */
export type DecisionMade = 'pending' | 'approved' | 'rejected';
