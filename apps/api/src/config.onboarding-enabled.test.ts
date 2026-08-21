/**
 * Unit tests for `AGGREGATOR_ONBOARDING_ENABLED` parsing (#637).
 *
 * Exercised through the exported pure functions rather than by mutating
 * process.env, because `config.ts` snapshots the environment at module load.
 * The route-level tests cover the live-env path separately.
 *
 * @module apps/api/config.onboarding-enabled.test
 */
import { describe, it, expect } from 'vitest';
import {
  parseOnboardingEnabled,
  unknownOnboardingCapabilities,
  isOnboardingCapabilityEnabled,
} from './config.js';

describe('parseOnboardingEnabled', () => {
  it('returns null for unset, empty and whitespace-only values (⇒ all enabled)', () => {
    // `null`, not `[]` — "unset" and "nothing enabled" must stay distinguishable.
    expect(parseOnboardingEnabled(undefined).capabilities).toBeNull();
    expect(parseOnboardingEnabled('').capabilities).toBeNull();
    expect(parseOnboardingEnabled('   ').capabilities).toBeNull();
    expect(parseOnboardingEnabled(undefined).warnings).toEqual([]);
  });

  it('parses a comma-separated allow-list in listed order', () => {
    expect(parseOnboardingEnabled('form,voice').capabilities).toEqual(['form', 'voice']);
    expect(parseOnboardingEnabled('voice,form').capabilities).toEqual(['voice', 'form']);
  });

  it('parses a single capability', () => {
    expect(parseOnboardingEnabled('form').capabilities).toEqual(['form']);
  });

  it('trims whitespace and lowercases each entry', () => {
    expect(parseOnboardingEnabled('  FORM , Voice  ').capabilities).toEqual(['form', 'voice']);
  });

  it('accepts newline separators as well as commas', () => {
    expect(parseOnboardingEnabled('form\nvoice').capabilities).toEqual(['form', 'voice']);
    expect(parseOnboardingEnabled('form,\nvoice\n').capabilities).toEqual(['form', 'voice']);
  });

  it('drops empty entries left by stray separators', () => {
    expect(parseOnboardingEnabled('form,,voice,').capabilities).toEqual(['form', 'voice']);
  });

  it('strips Helm double-quote wrapping', () => {
    expect(parseOnboardingEnabled('"form,voice"').capabilities).toEqual(['form', 'voice']);
  });

  it('strips Helm single-quote wrapping', () => {
    expect(parseOnboardingEnabled("'form'").capabilities).toEqual(['form']);
  });

  it('treats a value that is only quotes as unset, not as "nothing enabled"', () => {
    // `| quote` applied to an empty string. Unwrapping leaves nothing, which
    // is the same situation as never setting the var at all.
    expect(parseOnboardingEnabled('""').capabilities).toBeNull();
    expect(parseOnboardingEnabled("''").capabilities).toBeNull();
  });

  it('de-duplicates repeated values and warns once about the repeat', () => {
    const parsed = parseOnboardingEnabled('form,FORM,voice');
    expect(parsed.capabilities).toEqual(['form', 'voice']);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('duplicate');
    expect(parsed.warnings[0]).toContain('form');
  });

  it('reports an empty allow-list rather than falling back to all enabled', () => {
    // Set, but every entry was blank. Failing open here would silently
    // re-enable the modes the operator was trying to withhold.
    const parsed = parseOnboardingEnabled(',,');
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('names no capability');
  });

  it('emits no warnings for a clean allow-list', () => {
    expect(parseOnboardingEnabled('form,voice').warnings).toEqual([]);
  });

  it('keeps an unrecognised value verbatim — format is not validated here', () => {
    // The declared-mode cross-check runs later, once a network config exists.
    expect(parseOnboardingEnabled('frm').capabilities).toEqual(['frm']);
    expect(parseOnboardingEnabled('frm').warnings).toEqual([]);
  });
});

describe('unknownOnboardingCapabilities', () => {
  it('returns nothing when the allow-list is unset (it restricts nothing)', () => {
    expect(unknownOnboardingCapabilities(null, ['form', 'voice'])).toEqual([]);
  });

  it('names a typo that matches no declared mode', () => {
    expect(unknownOnboardingCapabilities(['frm'], ['form', 'voice'])).toEqual(['frm']);
  });

  it('flags `bulk` while bulk gating is unimplemented', () => {
    expect(unknownOnboardingCapabilities(['form', 'bulk'], ['form', 'voice'])).toEqual(['bulk']);
  });

  it('returns nothing when every value matches a declared mode', () => {
    expect(unknownOnboardingCapabilities(['form', 'voice'], ['form', 'voice'])).toEqual([]);
  });

  it('flags everything when the network declares no modes at all', () => {
    expect(unknownOnboardingCapabilities(['form'], [])).toEqual(['form']);
  });
});

describe('isOnboardingCapabilityEnabled', () => {
  // Mutates process.env deliberately: this is the live-env accessor, and the
  // point of reading env at call time is that it can change between requests.
  const original = process.env.AGGREGATOR_ONBOARDING_ENABLED;
  const set = (v: string | undefined): void => {
    if (v === undefined) delete process.env.AGGREGATOR_ONBOARDING_ENABLED;
    else process.env.AGGREGATOR_ONBOARDING_ENABLED = v;
  };

  it('enables everything when unset', () => {
    set(undefined);
    expect(isOnboardingCapabilityEnabled('form')).toBe(true);
    expect(isOnboardingCapabilityEnabled('voice')).toBe(true);
    // Even a mode nobody has invented yet: unset means "no restriction".
    expect(isOnboardingCapabilityEnabled('kiosk')).toBe(true);
    set(original);
  });

  it('enables only the listed capabilities when set', () => {
    set('form');
    expect(isOnboardingCapabilityEnabled('form')).toBe(true);
    expect(isOnboardingCapabilityEnabled('voice')).toBe(false);
    set(original);
  });

  it('treats form,voice as identical to unset', () => {
    set('form,voice');
    expect(isOnboardingCapabilityEnabled('form')).toBe(true);
    expect(isOnboardingCapabilityEnabled('voice')).toBe(true);
    set(original);
  });

  it('enables nothing when the value names no capability', () => {
    set(',,');
    expect(isOnboardingCapabilityEnabled('form')).toBe(false);
    expect(isOnboardingCapabilityEnabled('voice')).toBe(false);
    set(original);
  });
});
