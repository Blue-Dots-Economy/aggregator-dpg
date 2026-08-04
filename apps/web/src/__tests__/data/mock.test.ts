import { describe, it, expect } from 'vitest';
import {
  SEEKERS,
  PROVIDERS,
  OPP_PROVIDERS,
  SEEKER_LINKS,
  PROVIDER_LINKS,
  AGGREGATOR_PROFILE,
  ORGS,
} from '@/data/mock';

/**
 * `data/mock.ts` is a static fixture module (demo/dev seed data), not
 * behavioural logic — the only non-trivial runtime code is `withDir`, which
 * derives `initiated`/`received` directional stats from each row's `applied`
 * bucket. These are shape/derivation-correctness assertions, not exhaustive
 * per-row checks.
 */
describe('mock fixtures', () => {
  it('SEEKERS is a non-empty list with directional stats derived from applied', () => {
    expect(SEEKERS.length).toBeGreaterThan(0);
    const first = SEEKERS[0]!;
    expect(first.initiated).toEqual({
      create: first.applied.pending,
      accept: first.applied.accepted ?? 0,
      reject: first.applied.rejected,
      cancel: first.applied.cancelled ?? 0,
    });
    expect(first.received).toEqual({ create: 0, accept: 0, reject: 0, cancel: 0 });
  });

  it('PROVIDERS and OPP_PROVIDERS are non-empty with the same directional derivation', () => {
    expect(PROVIDERS.length).toBeGreaterThan(0);
    expect(OPP_PROVIDERS.length).toBeGreaterThan(0);
    for (const row of [...PROVIDERS, ...OPP_PROVIDERS]) {
      expect(row.initiated.create).toBe(row.applied.pending);
      expect(row.initiated.reject).toBe(row.applied.rejected);
    }
  });

  it('SEEKER_LINKS / PROVIDER_LINKS carry the expected registration-link shape', () => {
    expect(SEEKER_LINKS.length).toBeGreaterThan(0);
    expect(PROVIDER_LINKS.length).toBeGreaterThan(0);
    for (const link of [...SEEKER_LINKS, ...PROVIDER_LINKS]) {
      expect(typeof link.id).toBe('string');
      expect(typeof link.slug).toBe('string');
      expect(['Seeker', 'Provider']).toContain(link.kind);
    }
  });

  it('AGGREGATOR_PROFILE has the full profile shape', () => {
    expect(AGGREGATOR_PROFILE.id).toBeTruthy();
    expect(AGGREGATOR_PROFILE.contact.email).toContain('@');
    expect(AGGREGATOR_PROFILE.consent.profileCreation).toBe(true);
  });

  it('ORGS is a non-empty list of org name strings', () => {
    expect(ORGS.length).toBeGreaterThan(0);
    expect(ORGS.every((o) => typeof o === 'string')).toBe(true);
  });
});
