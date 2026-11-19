/**
 * Unit tests for the voice-bot resolution helpers.
 *
 * @module apps/api/services/voice-bots
 */
import { describe, it, expect } from 'vitest';
import type { ResolvedNetworkConfig, VoiceBot } from '@aggregator-dpg/network-config/interface';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import {
  botsForDomain,
  modeOffers,
  modeOffersVoice,
  resolveDefaultVoiceBot,
  resolveVoiceBot,
} from './index.js';

/** Builds a bot serving the given domains. */
function bot(key: string, domains: string[]): VoiceBot {
  return {
    key,
    display_name: `Bot ${key}`,
    phone: '+919876543210',
    languages: ['en'],
    domains,
  };
}

const A = bot('a', ['seeker']);
const B = bot('b', ['seeker']);
const P = bot('p', ['provider']);

/** Blue dot config with the given bots, defaults and extra registration modes. */
function cfg(
  voice_bots: VoiceBot[],
  default_voice_bots?: Record<string, string>,
): ResolvedNetworkConfig {
  const base = buildBlueDotConfig();
  return {
    ...base,
    aggregator: {
      ...base.aggregator,
      voice_bots,
      ...(default_voice_bots ? { default_voice_bots } : {}),
      registration_modes: {
        ...base.aggregator.registration_modes,
        voice_or_form: {
          label_i18n_key: 'k',
          submission_shape: 'account_only',
          public_hint_i18n_key: null,
          offers: ['voice', 'form'],
        },
      },
    },
  };
}

describe('botsForDomain', () => {
  it('lists only the bots that serve the domain', () => {
    expect(botsForDomain('seeker', cfg([A, B, P]))).toEqual([A, B]);
    expect(botsForDomain('provider', cfg([A, B, P]))).toEqual([P]);
  });
});

describe('resolveDefaultVoiceBot', () => {
  it('is null with two bots and no default', () => {
    expect(resolveDefaultVoiceBot('seeker', cfg([A, B, P]))).toBeNull();
  });

  it('uses the configured default', () => {
    expect(resolveDefaultVoiceBot('seeker', cfg([A, B, P], { seeker: 'a' }))).toEqual(A);
  });

  it('uses the only bot that serves the domain', () => {
    expect(resolveDefaultVoiceBot('provider', cfg([A, B, P]))).toEqual(P);
  });

  it('is null with no bots', () => {
    expect(resolveDefaultVoiceBot('seeker', cfg([]))).toBeNull();
  });
});

describe('resolveVoiceBot', () => {
  const c = cfg([A, B, P], { seeker: 'a' });

  it('returns the named bot', () => {
    expect(resolveVoiceBot({ voiceBotKey: 'b', domain: 'seeker' }, c)).toEqual({
      bot: B,
      fellBack: false,
    });
  });

  it('falls back to the default when the key is gone', () => {
    expect(resolveVoiceBot({ voiceBotKey: 'gone', domain: 'seeker' }, c)).toEqual({
      bot: A,
      fellBack: true,
    });
  });

  it('never returns a bot that does not serve the link domain', () => {
    expect(resolveVoiceBot({ voiceBotKey: 'p', domain: 'seeker' }, c)).toEqual({
      bot: A,
      fellBack: true,
    });
  });

  it('uses the default without fallback when no key is set', () => {
    expect(resolveVoiceBot({ voiceBotKey: null, domain: 'seeker' }, c)).toEqual({
      bot: A,
      fellBack: false,
    });
  });
});

describe('modeOffers', () => {
  const c = cfg([]);

  it('is form only when offers is absent', () => {
    expect(modeOffers('voice', c)).toEqual(['form']);
    expect(modeOffersVoice('voice', c)).toBe(false);
  });

  it('returns the declared offers', () => {
    expect(modeOffers('voice_or_form', c)).toEqual(['voice', 'form']);
    expect(modeOffersVoice('voice_or_form', c)).toBe(true);
  });

  it('is form only for an undeclared mode', () => {
    expect(modeOffers('undeclared', c)).toEqual(['form']);
  });
});
