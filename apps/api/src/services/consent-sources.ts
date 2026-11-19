/**
 * Ledger sources shared by the consent status read and the user store, in the
 * aggregator API (`@aggregator-dpg/api`). Kept in its own module so the user store
 * does not import `consent-status` (which pulls in the actor layer: an import cycle).
 */

/**
 * Ledger sources that record an acceptance of the terms.
 *
 * Bulk-upload attestations (`bulk_upload:<id>:v<n>`) are not an acceptance.
 */
export const ACCEPTED_CONSENT_SOURCES = [
  'registration',
  'registration-backfill',
  'first-login',
] as const;
