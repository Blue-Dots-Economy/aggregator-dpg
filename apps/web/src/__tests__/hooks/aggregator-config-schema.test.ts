import { describe, it, expect } from 'vitest';
import blueDot from '../fixtures/aggregator-config.blue_dot.json';
import purpleDot from '../fixtures/aggregator-config.purple_dot.json';
import orangeDot from '../fixtures/aggregator-config.orange_dot.json';
import { AggregatorConfigPayloadSchema } from '@/hooks/useAggregatorConfig';

// Fixtures are `GET /v1/aggregator-config` responses from the API, built from
// this repo's config/ for each network.
describe('AggregatorConfigPayloadSchema', () => {
  it.each([
    ['blue_dot', blueDot],
    ['purple_dot', purpleDot],
    ['orange_dot', orangeDot],
  ])('parses the API payload for %s', (_network, payload) => {
    const parsed = AggregatorConfigPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it('keeps the registration modes and their resolved signals_cta', () => {
    const parsed = AggregatorConfigPayloadSchema.parse(blueDot);
    const modes = Object.values(parsed.registration_modes ?? {});
    expect(modes.length).toBeGreaterThan(0);
    for (const mode of modes) expect(typeof mode.signals_cta).toBe('boolean');
  });

  it('rejects a registration mode without signals_cta, which the API always sends', () => {
    const { signals_cta: _resolved, ...form } = blueDot.registration_modes.form;
    const parsed = AggregatorConfigPayloadSchema.safeParse({
      ...blueDot,
      registration_modes: { form },
    });
    expect(parsed.success).toBe(false);
  });
});
