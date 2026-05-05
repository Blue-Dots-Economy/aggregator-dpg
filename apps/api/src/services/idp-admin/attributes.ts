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

export const KC_ATTR = {
  /** Postgres aggregator UUID — reverse pointer from KC to our DB. */
  AGGREGATOR_ID: 'aggregator_id',
  /** URL-safe slug of the aggregator's organisation. */
  ORG_SLUG: 'org_slug',
  /** `seeker` or `provider` — fixed at submit time. */
  AGGREGATOR_TYPE: 'aggregator_type',
  /** Free-form organisation name as typed on the registration form. */
  ASSOCIATION: 'association',
  /** Applicant phone in E.164. Read by the OTP login authenticator. */
  PHONE_NUMBER: 'phoneNumber',
  /** `approved` or `rejected` — written by the admin decision endpoint. */
  DECISION_MADE: 'decision_made',
  /** ISO timestamp of the admin decision. */
  DECIDED_AT: 'decided_at',
  /** Free-form admin rejection reason. */
  REJECTION_REASON: 'rejection_reason',
} as const;

export type KcAttrName = (typeof KC_ATTR)[keyof typeof KC_ATTR];
