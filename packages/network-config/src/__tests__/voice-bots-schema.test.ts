/**
 * Unit tests for the per-instance voice-bot config schema.
 *
 * @module @aggregator-dpg/network-config
 */
import { describe, it, expect } from 'vitest';
import { AggregatorYamlSchema } from '../interface.js';

const BOT = {
  key: 'a',
  display_name: 'Bot A',
  phone: '+919876543210',
  languages: ['en'],
  domains: ['seeker'],
};

/** Builds a parseable YAML object with the given aggregator-level extras. */
function yamlWith(extra: Record<string, unknown>): unknown {
  return {
    aggregator: {
      name: 'Test',
      network: { source: 'https://example.invalid/n.json' },
      brand: { short_name: 'B', long_name: 'Blue', url_slug: 'blue' },
      ...extra,
    },
  };
}

/** Collects all issue messages of a failed parse into one string. */
function errorText(input: unknown): string {
  const r = AggregatorYamlSchema.safeParse(input);
  expect(r.success).toBe(false);
  return r.success ? '' : JSON.stringify(r.error.issues);
}

describe('voice_bots schema', () => {
  it('parses a valid block', () => {
    const r = AggregatorYamlSchema.safeParse(
      yamlWith({ voice_bots: [BOT], default_voice_bots: { seeker: 'a' } }),
    );
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.aggregator.voice_bots).toHaveLength(1);
  });

  it('defaults voice_bots to an empty list when absent', () => {
    const r = AggregatorYamlSchema.safeParse(yamlWith({}));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.aggregator.voice_bots).toEqual([]);
  });

  it('rejects duplicate keys, naming voice_bots', () => {
    expect(errorText(yamlWith({ voice_bots: [BOT, BOT] }))).toContain('voice_bots');
  });

  it('rejects a default naming an unlisted bot', () => {
    expect(
      errorText(yamlWith({ voice_bots: [BOT], default_voice_bots: { seeker: 'x' } })),
    ).toContain('default_voice_bots');
  });

  it('rejects a default naming a bot that does not serve the domain', () => {
    const provider = { ...BOT, key: 'x', domains: ['provider'] };
    expect(
      errorText(yamlWith({ voice_bots: [BOT, provider], default_voice_bots: { seeker: 'x' } })),
    ).toContain('default_voice_bots');
  });

  it('rejects two bots serving a domain with no default, naming the domain', () => {
    const text = errorText(yamlWith({ voice_bots: [BOT, { ...BOT, key: 'b' }] }));
    expect(text).toContain('default_voice_bots.seeker is required');
  });

  it('parses two bots serving a domain when a default is set', () => {
    const r = AggregatorYamlSchema.safeParse(
      yamlWith({ voice_bots: [BOT, { ...BOT, key: 'b' }], default_voice_bots: { seeker: 'b' } }),
    );
    expect(r.success).toBe(true);
  });

  it('does not require a default for a domain with one bot', () => {
    const provider = { ...BOT, key: 'p', domains: ['provider'] };
    expect(AggregatorYamlSchema.safeParse(yamlWith({ voice_bots: [BOT, provider] })).success).toBe(
      true,
    );
  });

  it('rejects a key a coordinator could never pick', () => {
    expect(errorText(yamlWith({ voice_bots: [{ ...BOT, key: 'example-bot' }] }))).toContain('key');
  });

  it('rejects an invalid phone', () => {
    expect(errorText(yamlWith({ voice_bots: [{ ...BOT, phone: '12345' }] }))).toContain('phone');
  });

  it('stores the normalised E.164 phone', () => {
    const r = AggregatorYamlSchema.safeParse(
      yamlWith({ voice_bots: [{ ...BOT, phone: '98765 43210' }] }),
    );
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.aggregator.voice_bots[0]?.phone).toBe('+919876543210');
  });

  it('accepts a number from outside India', () => {
    const r = AggregatorYamlSchema.safeParse(
      yamlWith({ voice_bots: [{ ...BOT, phone: '+44 20 7946 0958' }] }),
    );
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.aggregator.voice_bots[0]?.phone).toBe('+442079460958');
  });

  it('accepts a landline, as bots are often on one', () => {
    const r = AggregatorYamlSchema.safeParse(
      yamlWith({ voice_bots: [{ ...BOT, phone: '+91 120 440 4274' }] }),
    );
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.aggregator.voice_bots[0]?.phone).toBe('+911204404274');
  });

  it('rejects empty languages and empty domains', () => {
    expect(
      AggregatorYamlSchema.safeParse(yamlWith({ voice_bots: [{ ...BOT, languages: [] }] })).success,
    ).toBe(false);
    expect(
      AggregatorYamlSchema.safeParse(yamlWith({ voice_bots: [{ ...BOT, domains: [] }] })).success,
    ).toBe(false);
  });
});

describe('registration mode offers', () => {
  const mode = {
    label_i18n_key: 'k',
    submission_shape: 'account_only',
    public_hint_i18n_key: null,
  };

  it('rejects duplicate offers', () => {
    const r = AggregatorYamlSchema.safeParse(
      yamlWith({ registration_modes: { m: { ...mode, offers: ['voice', 'voice'] } } }),
    );
    expect(r.success).toBe(false);
  });

  it('rejects an empty offers list', () => {
    const r = AggregatorYamlSchema.safeParse(
      yamlWith({ registration_modes: { m: { ...mode, offers: [] } } }),
    );
    expect(r.success).toBe(false);
  });

  it('parses when offers is absent or valid', () => {
    expect(
      AggregatorYamlSchema.safeParse(yamlWith({ registration_modes: { m: mode } })).success,
    ).toBe(true);
    expect(
      AggregatorYamlSchema.safeParse(
        yamlWith({ registration_modes: { m: { ...mode, offers: ['voice', 'form'] } } }),
      ).success,
    ).toBe(true);
  });
});
