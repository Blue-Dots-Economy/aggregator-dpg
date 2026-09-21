/**
 * #640 moved the form out of this repo: it is read from the published
 * `aggregator-forms.json` on the mounted schemas tree. The resolver is covered
 * by `schema-ref.test.ts` on the API side against a real temp tree, so here the
 * loader is mocked and what is asserted is the enum patch, the derived
 * uiSchema, and the bundle-absent behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { loadPublishedForm } = vi.hoisted(() => ({ loadPublishedForm: vi.fn() }));
vi.mock('@/lib/aggregator-forms.server', () => ({ loadPublishedForm }));

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

  beforeEach(() => {
    loadPublishedForm.mockReset();
    // Only the domain-enum patch still goes over HTTP.
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ domains: [{ id: 'seeker', label: 'Seekers' }] }), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('loads schema + uiSchema from the mounted bundle and patches the type enum', async () => {
    loadPublishedForm.mockResolvedValue({
      type: 'object',
      properties: { type: { enum: ['old'] } },
    });

    const result = await loadRegistrationSchema();
    expect(loadPublishedForm).toHaveBeenCalledWith('coordinator-registration');
    expect(
      (result.schema.properties as Record<string, Record<string, unknown>>).type!.enum,
    ).toEqual(['seeker']);
    expect(result.uiSchema.type).toEqual({ 'ui:enumNames': ['Seekers'] });
  });

  it("derives the uiSchema from the schema's own x-rjsf annotations", async () => {
    loadPublishedForm.mockResolvedValue({
      type: 'object',
      properties: { name: { type: 'string', 'x-rjsf': { placeholder: 'Your name' } } },
    });

    const result = await loadRegistrationSchema();
    expect(result.uiSchema.name).toEqual({ 'ui:placeholder': 'Your name' });
  });

  it('throws SchemaUnavailableError when the mount carries no such form', async () => {
    // Nothing is baked into the image to fall back to since #640 — rendering a
    // blank form the visitor could "submit" would be worse than failing loudly.
    loadPublishedForm.mockResolvedValue(null);
    await expect(loadRegistrationSchema()).rejects.toBeInstanceOf(SchemaUnavailableError);
  });
});
