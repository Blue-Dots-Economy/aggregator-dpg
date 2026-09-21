/**
 * Unit tests for the registration-schema Ajv validator loader.
 *
 * Since #640 the schema comes from the published `aggregator-forms.json` on
 * the mounted config tree, so these write a synthetic bundle to a temp
 * `CONFIG_ROOT` rather than relying on a file this repo ships. `network-config`
 * is still mocked, because the domain enum is patched from it.
 *
 * What matters here is what the route depends on: a missing bundle yields
 * `null` (→ 503, never an unvalidated accept), the `null` stays retryable, and
 * patching the enum must not mutate the cached bundle.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { writeFormsBundle, buildFormsBundle } from '@aggregator-dpg/network-config/testing';

const { mockGetNetworkConfig } = vi.hoisted(() => ({ mockGetNetworkConfig: vi.fn() }));
vi.mock('./network-config.js', () => ({ getNetworkConfig: mockGetNetworkConfig }));

const roots: string[] = [];

/** Points CONFIG_ROOT at a fresh temp tree holding `forms`. */
function mountForms(forms = buildFormsBundle()): void {
  const root = writeFormsBundle(forms);
  roots.push(root);
  process.env.CONFIG_ROOT = root;
}

describe('getRegistrationValidator', () => {
  const origRoot = process.env.CONFIG_ROOT;

  beforeEach(async () => {
    mockGetNetworkConfig.mockReset();
    mockGetNetworkConfig.mockResolvedValue({ domainIds: ['seeker', 'provider'] });
    const { _resetValidator } = await import('./registration-validator.js');
    const { _resetFormsBundle } = await import('./aggregator-forms.js');
    _resetValidator();
    _resetFormsBundle();
  });

  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.CONFIG_ROOT;
    else process.env.CONFIG_ROOT = origRoot;
  });

  it('patches properties.type.enum with the live network domain ids', async () => {
    mountForms();
    mockGetNetworkConfig.mockResolvedValue({ domainIds: ['student', 'mentor'] });
    const { getRegistrationValidator } = await import('./registration-validator.js');
    const validate = await getRegistrationValidator();
    expect(validate).not.toBeNull();

    const body = {
      name: 'Acme',
      contact: { name: 'Jo', phone: '9876543210', email: 'jo@x.com' },
      consent: { value: true },
    };
    // 'seeker' is in the published enum but not this network's domains.
    expect(validate!({ ...body, type: 'seeker' })).toBe(false);
    expect(validate!({ ...body, type: 'student' })).toBe(true);
  });

  it('keeps the published enum when the network reports no domain ids', async () => {
    mountForms();
    mockGetNetworkConfig.mockResolvedValue({ domainIds: [] });
    const { getRegistrationValidator } = await import('./registration-validator.js');
    const validate = await getRegistrationValidator();
    expect(
      validate!({
        name: 'Acme',
        type: 'seeker',
        contact: { name: 'Jo', phone: '9876543210', email: 'jo@x.com' },
        consent: { value: true },
      }),
    ).toBe(true);
  });

  it('does not mutate the cached bundle when patching the enum', async () => {
    // The parsed bundle is cached process-wide; a patch leaking into it would
    // hand one network's domains to every later reader.
    mountForms();
    mockGetNetworkConfig.mockResolvedValue({ domainIds: ['student'] });
    const { getRegistrationValidator } = await import('./registration-validator.js');
    await getRegistrationValidator();

    const { getPublishedForm } = await import('./aggregator-forms.js');
    const form = getPublishedForm('coordinator-registration');
    const props = form!.schema['properties'] as Record<string, { enum?: string[] }>;
    expect(props['type']!.enum).toEqual(['seeker', 'provider']);
  });

  it('returns null when the bundle carries no coordinator-registration form', async () => {
    mountForms({ forms: { profile: { type: 'object' } } });
    const { getRegistrationValidator } = await import('./registration-validator.js');
    await expect(getRegistrationValidator()).resolves.toBeNull();
  });

  it('returns null when the mount carries no bundle at all', async () => {
    // A deployment whose schemas tree never arrived: 503, not a 500 and never
    // an unvalidated accept.
    process.env.CONFIG_ROOT = '/nonexistent-config-root';
    const { getRegistrationValidator } = await import('./registration-validator.js');
    await expect(getRegistrationValidator()).resolves.toBeNull();
  });

  it('does not cache the null — a later call can still succeed', async () => {
    // An instance that started before its mount was ready would otherwise
    // answer 503 for the life of the process.
    process.env.CONFIG_ROOT = '/nonexistent-config-root';
    const { getRegistrationValidator } = await import('./registration-validator.js');
    expect(await getRegistrationValidator()).toBeNull();

    mountForms();
    expect(await getRegistrationValidator()).not.toBeNull();
  });

  it('caches the compiled validator across calls', async () => {
    mountForms();
    const { getRegistrationValidator } = await import('./registration-validator.js');
    expect(await getRegistrationValidator()).toBe(await getRegistrationValidator());
  });
});
