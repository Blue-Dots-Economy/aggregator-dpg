/**
 * Unit tests for the registration-schema Ajv validator loader.
 *
 * Since #640 the schema comes from the published bundle on the resolved
 * network config, not from disk, so these mock `./network-config.js` and hand
 * back a `forms` bundle. What matters here is the behaviour the route depends
 * on: a missing bundle yields `null` (→ 503, never an unvalidated accept), the
 * `null` stays retryable, and patching the domain enum must not mutate the
 * shared config singleton.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockGetNetworkConfig } = vi.hoisted(() => ({
  mockGetNetworkConfig: vi.fn(),
}));

vi.mock('./network-config.js', () => ({
  getNetworkConfig: mockGetNetworkConfig,
}));

/** A minimal coordinator-registration form with the patchable `type` enum. */
function form(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['seeker', 'provider'] },
      name: { type: 'string', minLength: 2 },
    },
  };
}

/** A resolved config carrying `forms`, as the loader would produce. */
function cfg(domainIds: string[], forms: Record<string, unknown> | undefined = undefined) {
  return {
    domainIds,
    forms: forms === undefined ? { forms: { 'coordinator-registration': form() } } : forms,
  };
}

describe('getRegistrationValidator', () => {
  beforeEach(async () => {
    mockGetNetworkConfig.mockReset();
    const { _resetValidator } = await import('./registration-validator.js');
    _resetValidator();
  });

  it('patches properties.type.enum with the live network domain ids', async () => {
    mockGetNetworkConfig.mockResolvedValue(cfg(['student', 'mentor']));
    const { getRegistrationValidator } = await import('./registration-validator.js');
    const validate = await getRegistrationValidator();
    expect(validate).not.toBeNull();
    // 'seeker' is in the published enum but not this network's domains.
    expect(validate!({ type: 'seeker', name: 'Acme' })).toBe(false);
    expect(validate!({ type: 'student', name: 'Acme' })).toBe(true);
  });

  it('keeps the published enum when the network reports no domain ids', async () => {
    mockGetNetworkConfig.mockResolvedValue(cfg([]));
    const { getRegistrationValidator } = await import('./registration-validator.js');
    const validate = await getRegistrationValidator();
    expect(validate!({ type: 'seeker', name: 'Acme' })).toBe(true);
  });

  it('does not mutate the shared config bundle when patching the enum', async () => {
    // The bundle is the process-wide singleton that also answers
    // GET /v1/aggregator-forms — a patch leaking into it would serve one
    // network's domains to every reader.
    const shared = cfg(['student']);
    mockGetNetworkConfig.mockResolvedValue(shared);
    const { getRegistrationValidator } = await import('./registration-validator.js');
    await getRegistrationValidator();
    const published = (shared.forms as { forms: Record<string, Record<string, never>> }).forms[
      'coordinator-registration'
    ] as unknown as {
      properties: { type: { enum: string[] } };
    };
    expect(published.properties.type.enum).toEqual(['seeker', 'provider']);
  });

  it('returns null when the bundle carries no coordinator-registration form', async () => {
    mockGetNetworkConfig.mockResolvedValue(cfg(['seeker'], { forms: { profile: {} } }));
    const { getRegistrationValidator } = await import('./registration-validator.js');
    await expect(getRegistrationValidator()).resolves.toBeNull();
  });

  it('returns null when no bundle resolved at all', async () => {
    mockGetNetworkConfig.mockResolvedValue({ domainIds: ['seeker'], forms: undefined });
    const { getRegistrationValidator } = await import('./registration-validator.js');
    await expect(getRegistrationValidator()).resolves.toBeNull();
  });

  it('returns null rather than throwing when network-config fails', async () => {
    // Must stay a 503 (misconfigured deployment), not a 500 (bad request).
    mockGetNetworkConfig.mockRejectedValue(new Error('network-config load failed'));
    const { getRegistrationValidator } = await import('./registration-validator.js');
    await expect(getRegistrationValidator()).resolves.toBeNull();
  });

  it('does not cache the null — a later call can still succeed', async () => {
    // An instance that raced its first request against config resolution would
    // otherwise answer 503 for the life of the process.
    mockGetNetworkConfig.mockRejectedValueOnce(new Error('cold'));
    const { getRegistrationValidator } = await import('./registration-validator.js');
    expect(await getRegistrationValidator()).toBeNull();

    mockGetNetworkConfig.mockResolvedValue(cfg(['seeker']));
    expect(await getRegistrationValidator()).not.toBeNull();
  });

  it('caches the compiled validator across calls', async () => {
    mockGetNetworkConfig.mockResolvedValue(cfg(['seeker']));
    const { getRegistrationValidator } = await import('./registration-validator.js');
    const a = await getRegistrationValidator();
    const b = await getRegistrationValidator();
    expect(a).toBe(b);
  });
});
