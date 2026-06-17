/**
 * Pure FSM definitions for the aggregator registration state machine.
 *
 * No I/O — safe to import from routes, the reconciler worker, and tests.
 * All state-change logic flows through `registration-store` `transition()`;
 * this module only declares what transitions are valid and what projections
 * each state requires.
 */

import type { RegistrationState } from './registration-store/interface.js';

export type { RegistrationState };

/**
 * States from which an applicant may re-register with the same contact.
 *
 * `active` is deliberately excluded: an active aggregator's email/phone
 * must continue to block duplicate registrations.
 */
export const REREGISTERABLE_STATES: ReadonlyArray<RegistrationState> = ['rejected', 'abandoned'];

/**
 * States with no outgoing transitions in the FSM.
 *
 * Note: `active` is NOT treated as terminal for reconciler purposes — the
 * reconciler may still retry failed projections (KC user, signalstack org,
 * welcome email) on active rows.
 */
export const TRANSITION_TERMINAL_STATES: ReadonlyArray<RegistrationState> = [
  'rejected',
  'active',
  'abandoned',
];

const ALLOWED: Readonly<Record<RegistrationState, ReadonlyArray<RegistrationState>>> = {
  submitted: ['verified', 'abandoned'],
  verified: ['approved', 'rejected', 'abandoned'],
  approved: ['active', 'abandoned'],
  rejected: [],
  active: [],
  abandoned: [],
};

/**
 * Returns true when the `from → to` transition is a permitted FSM edge.
 *
 * @param from - Current state.
 * @param to - Desired next state.
 */
export function isAllowedTransition(from: RegistrationState, to: RegistrationState): boolean {
  return (ALLOWED[from] as RegistrationState[]).includes(to);
}

/**
 * Describes which idempotent projection executors are desired for a state.
 *
 * Each field maps to one `ProvisionKey`. The reconciler calls the matching
 * `ensure*` executor for every `true` field, skipping any that already have
 * `provisionState[key] === 'done'`.
 */
export interface DesiredProjections {
  /** Send verification email/link to the applicant. */
  verification: boolean;
  /** Notify admins with approve/reject deep-links. */
  admin_notify: boolean;
  /** Keycloak user should exist, be enabled, with `decision_made=approved`. */
  kc_user: boolean;
  /** Keycloak user should exist but be disabled, with `decision_made=rejected`. */
  kc_disabled: boolean;
  /** Keycloak user should be deleted (PII purge for abandoned rows). */
  kc_purged: boolean;
  /** Signalstack org should be upserted with this aggregator's `external_id`. */
  ss_org: boolean;
  /** `aggregators` + `aggregator_profiles` row should exist (graduation). */
  graduated: boolean;
  /** Welcome email sent to the applicant after approval. */
  welcome: boolean;
  /** Rejection email sent to the applicant. */
  rejection: boolean;
}

/**
 * Returns the desired projection set for a given registration state.
 *
 * The reconciler drives each desired projection to `done` by calling the
 * matching idempotent `ensure*` executor. Executors skip work whose
 * `provisionState[key]` is already `'done'`.
 *
 * @param state - Current FSM state.
 * @returns Object with one boolean per projection key.
 */
export function desiredProjections(state: RegistrationState): DesiredProjections {
  const isApprovedOrActive = state === 'approved' || state === 'active';
  return {
    verification: state === 'submitted',
    admin_notify: state === 'verified',
    kc_user: isApprovedOrActive,
    kc_disabled: state === 'rejected',
    kc_purged: state === 'abandoned',
    ss_org: isApprovedOrActive,
    graduated: isApprovedOrActive,
    welcome: isApprovedOrActive,
    rejection: state === 'rejected',
  };
}
