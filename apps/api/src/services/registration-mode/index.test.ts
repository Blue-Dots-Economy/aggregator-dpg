import { describe, it, expect } from 'vitest';
import { resolveSubmissionShape, isModeDeclared } from './index.js';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';

const cfg = {
  aggregator: {
    registration_modes: {
      voice: {
        label_i18n_key: 'registration_mode.voice.label',
        submission_shape: 'account_only',
        public_hint_i18n_key: 'registration_mode.voice.hint',
      },
      form: {
        label_i18n_key: 'registration_mode.form.label',
        submission_shape: 'account_and_profile',
        public_hint_i18n_key: null,
      },
    },
  },
} as unknown as ResolvedNetworkConfig;

describe('resolveSubmissionShape', () => {
  it('returns the configured shape for a declared mode', () => {
    expect(resolveSubmissionShape('voice', cfg)).toBe('account_only');
    expect(resolveSubmissionShape('form', cfg)).toBe('account_and_profile');
  });

  it('returns account_and_profile (graceful default) for an unknown mode', () => {
    expect(resolveSubmissionShape('sms_campaign', cfg)).toBe('account_and_profile');
  });
});

describe('isModeDeclared', () => {
  it('true for declared keys', () => {
    expect(isModeDeclared('voice', cfg)).toBe(true);
    expect(isModeDeclared('form', cfg)).toBe(true);
  });
  it('false for unknown keys', () => {
    expect(isModeDeclared('kiosk', cfg)).toBe(false);
  });
});
