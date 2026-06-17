/**
 * Public testing surface for the registration store.
 *
 * Cross-package consumers must import from this file rather than reaching
 * into the in-memory implementation directly.
 */

import { InMemoryRegistrationStore } from './memory.js';
import type { Registration, CreateRegistrationInput } from './interface.js';

export class RegistrationStoreFake extends InMemoryRegistrationStore {
  /**
   * Pre-seeds the store with fully formed rows, bypassing validation.
   *
   * @param rows - Rows to insert directly into the in-memory state.
   */
  seed(rows: Registration[]): void {
    for (const r of rows) {
      this.byId.set(r.id, r);
      this.byIdempotencyKey.set(r.idempotencyKey, r.id);
    }
  }
}

/**
 * Builds a valid Registration for use in tests.
 *
 * @param overrides - Fields to override from the deterministic defaults.
 * @returns A registration that passes all schema constraints.
 */
export function buildRegistration(overrides: Partial<Registration> = {}): Registration {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    id: '00000000-0000-0000-0000-000000000001',
    idempotencyKey: 'test-idempotency-key-001',
    state: 'submitted',
    contactEmail: 'applicant@example.com',
    contactPhone: '+919876543210',
    orgName: 'Test Organisation',
    orgType: 'seeker',
    orgUrl: null,
    orgLocations: [],
    profileDraft: {},
    consent: {
      value: true,
      given_at: '2026-01-01T00:00:00.000Z',
      valid_till: '2027-01-01T00:00:00.000Z',
    },
    idpUserId: null,
    signalstackOrgId: null,
    aggregatorId: null,
    verificationSentAt: null,
    verifiedAt: null,
    adminNotifiedAt: null,
    approvalLinkIssuedAt: null,
    provisionState: {},
    version: 0,
    reconcilerClaimedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

/** Builds a minimal CreateRegistrationInput for use in tests. */
export function buildCreateRegistrationInput(
  overrides: Partial<CreateRegistrationInput> = {},
): CreateRegistrationInput {
  return {
    idempotencyKey: 'test-idempotency-key-001',
    contactEmail: 'applicant@example.com',
    contactPhone: '+919876543210',
    orgName: 'Test Organisation',
    orgType: 'seeker',
    orgUrl: null,
    orgLocations: [],
    profileDraft: {},
    consent: {
      value: true,
      given_at: '2026-01-01T00:00:00.000Z',
      valid_till: '2027-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}
