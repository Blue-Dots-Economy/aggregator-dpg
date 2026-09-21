/**
 * #640 removed `resolveAggregatorSchemaPath` along with the on-disk schemas —
 * the form now comes only from the published bundle, so the tests that asserted
 * filesystem precedence went with it. What replaces them is the bundle-present
 * and bundle-absent behaviour at the bottom of this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { patchTypeFromNetwork, loadRegistrationSchema, SchemaUnavailableError } =
  await import('@/lib/aggregator-schema.server');

describe('patchTypeFromNetwork', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.API_BASE_URL = 'http://api.internal:4000';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.API_BASE_URL;
  });

  it('patches the type enum + ui:enumNames from the live network config', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          domains: [
            { id: 'seeker', label: 'Seekers' },
            { id: 'provider', label: 'Providers' },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const schema = { properties: { type: { enum: ['old'] } } } as never;
    const uiSchema: Record<string, unknown> = {};
    await patchTypeFromNetwork(schema, uiSchema);

    const props = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.type!.enum).toEqual(['seeker', 'provider']);
    expect(props.type!.oneOf).toEqual([
      { const: 'seeker', title: 'Seekers' },
      { const: 'provider', title: 'Providers' },
    ]);
    expect(uiSchema.type).toEqual({ 'ui:enumNames': ['Seekers', 'Providers'] });
  });

  it('falls back to the id when a domain has no label', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ domains: [{ id: 'tourist' }] }), { status: 200 }),
      ) as unknown as typeof fetch;
    const schema = { properties: { type: {} } } as never;
    const uiSchema: Record<string, unknown> = {};
    await patchTypeFromNetwork(schema, uiSchema);
    const props = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.type!.oneOf).toEqual([{ const: 'tourist', title: 'tourist' }]);
  });

  it('leaves the schema untouched when the response is not ok', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const schema = { properties: { type: { enum: ['seeker'] } } } as never;
    const uiSchema: Record<string, unknown> = {};
    await patchTypeFromNetwork(schema, uiSchema);
    const props = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.type!.enum).toEqual(['seeker']);
    expect(uiSchema.type).toBeUndefined();
  });

  it('leaves the schema untouched when domains is empty', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ domains: [] }), { status: 200 }),
      ) as unknown as typeof fetch;
    const schema = { properties: { type: { enum: ['seeker'] } } } as never;
    await patchTypeFromNetwork(schema, {});
    const props = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.type!.enum).toEqual(['seeker']);
  });

  it('falls back silently when the fetch throws', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const schema = { properties: { type: { enum: ['seeker'] } } } as never;
    await expect(patchTypeFromNetwork(schema, {})).resolves.toBeUndefined();
    const props = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.type!.enum).toEqual(['seeker']);
  });

  it('no-ops when the schema has no `type` property', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ domains: [{ id: 'seeker' }] }), { status: 200 }),
      ) as unknown as typeof fetch;
    const schema = { properties: {} } as never;
    await expect(patchTypeFromNetwork(schema, {})).resolves.toBeUndefined();
  });
});

describe('loadRegistrationSchema', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  /** Routes the two calls the loader makes: the form bundle and the config. */
  function mockFetch(forms: unknown) {
    globalThis.fetch = vi.fn((url: string) =>
      Promise.resolve(
        String(url).includes('/v1/aggregator-forms')
          ? new Response(JSON.stringify({ forms }), { status: 200 })
          : new Response(JSON.stringify({ domains: [{ id: 'seeker', label: 'Seekers' }] }), {
              status: 200,
            }),
      ),
    ) as unknown as typeof fetch;
  }

  it('loads schema + uiSchema from the published bundle and patches the type enum', async () => {
    mockFetch({
      'coordinator-registration': {
        type: 'object',
        properties: { type: { enum: ['old'] } },
      },
    });

    const result = await loadRegistrationSchema();
    expect(
      (result.schema.properties as Record<string, Record<string, unknown>>).type!.enum,
    ).toEqual(['seeker']);
    expect(result.uiSchema.type).toEqual({ 'ui:enumNames': ['Seekers'] });
  });

  it("derives the uiSchema from the published schema's own x-rjsf annotations", async () => {
    mockFetch({
      'coordinator-registration': {
        type: 'object',
        properties: { name: { type: 'string', 'x-rjsf': { placeholder: 'Your name' } } },
      },
    });

    const result = await loadRegistrationSchema();
    expect(result.uiSchema.name).toEqual({ 'ui:placeholder': 'Your name' });
  });

  it('throws SchemaUnavailableError when the bundle carries no such form', async () => {
    // There is no on-disk copy to fall back to since #640 — rendering a blank
    // form the visitor could "submit" would be worse than failing loudly.
    mockFetch({ profile: {} });
    await expect(loadRegistrationSchema()).rejects.toBeInstanceOf(SchemaUnavailableError);
  });

  it('throws SchemaUnavailableError when no bundle is published at all', async () => {
    mockFetch(null);
    await expect(loadRegistrationSchema()).rejects.toBeInstanceOf(SchemaUnavailableError);
  });
});
