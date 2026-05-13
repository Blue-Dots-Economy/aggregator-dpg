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
 * Per the two-table refactor, Keycloak only carries three attributes:
 *
 *   - `aggregator_id` — reverse pointer to Postgres
 *   - `phoneNumber`   — read by the OTP login authenticator
 *   - `decision_made` — gates login at the auth middleware
 *
 * Everything else (org_slug, name, contact details, decision metadata,
 * rejection reason, etc.) lives in Postgres. The deprecated constants below
 * remain so existing realm exports and any in-flight reads do not blow up
 * mid-migration; new code MUST NOT write them.
 */
export const KC_ATTR = {
  /** Postgres aggregator UUID — reverse pointer from KC to our DB. */
  AGGREGATOR_ID: 'aggregator_id',
  /** Applicant phone in E.164. Read by the OTP login authenticator. */
  PHONE_NUMBER: 'phoneNumber',
  /** `pending` / `approved` / `rejected` — the login gate. */
  DECISION_MADE: 'decision_made',

  // ─── Deprecated (do not write from new code) ────────────────────────────
  /** @deprecated Slug lives in Postgres (`aggregators.org_slug`). */
  ORG_SLUG: 'org_slug',
  /** @deprecated Type lives in Postgres (`aggregators.type` + `actor_type`). */
  AGGREGATOR_TYPE: 'aggregator_type',
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
