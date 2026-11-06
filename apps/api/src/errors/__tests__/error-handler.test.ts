import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { httpError } from '../http-error.js';

describe('global error handler envelope', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    // Register a synthetic route that throws each kind of error.
    app.post('/__test/throw', { config: { rbac: { access: 'public' } } }, async (req) => {
      const code = (req.body as { code?: string })?.code ?? 'INTERNAL';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throw httpError(code as any);
    });
    app.post('/__test/native-throw', { config: { rbac: { access: 'public' } } }, async () => {
      throw new Error('boom from inside');
    });
    app.post('/__test/validation', { config: { rbac: { access: 'public' } } }, async () => {
      throw Object.assign(new Error('body/name must be string'), {
        validation: [{ instancePath: '/name', message: 'must be string' }],
      });
    });
    app.post('/__test/empty-validation', { config: { rbac: { access: 'public' } } }, async () => {
      throw Object.assign(new Error('no issues'), { validation: [] });
    });
    app.post('/__test/too-large', { config: { rbac: { access: 'public' } } }, async () => {
      throw Object.assign(new Error('body too large'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('renders a PHONE_EXISTS conflict in the canonical envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__test/throw',
      payload: { code: 'PHONE_EXISTS' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: {
        code: string;
        title: string;
        detail: string;
        requestId: string;
        timestamp: string;
      };
    };
    expect(body.error.code).toBe('PHONE_EXISTS');
    expect(body.error.title).toBe('Phone already in use');
    expect(body.error.detail).toBeTruthy();
    expect(body.error.requestId).toMatch(/^req-/);
    expect(body.error.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('honours an inbound x-request-id header in the response and envelope', async () => {
    const inbound = 'req-trace-from-bff-12345';
    const res = await app.inject({
      method: 'POST',
      url: '/__test/throw',
      headers: { 'x-request-id': inbound },
      payload: { code: 'NOT_FOUND' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBe(inbound);
    const body = res.json() as { error: { requestId: string } };
    expect(body.error.requestId).toBe(inbound);
  });

  it('coerces a plain thrown Error into the INTERNAL envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__test/native-throw',
      payload: {},
    });
    expect(res.statusCode).toBe(500);
    const body = res.json() as {
      error: { code: string; title: string; requestId: string };
    };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.title).toBe('Something went wrong');
    expect(body.error.requestId).toMatch(/^req-/);
  });

  it('NEVER leaks hint or stack into the wire envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__test/native-throw',
      payload: {},
    });
    expect(res.body).not.toContain('"hint"');
    expect(res.body).not.toContain('"stack"');
    expect(res.body).not.toContain('boom from inside');
  });

  it('maps an error with validation issues to SCHEMA_VALIDATION with the issues', async () => {
    const res = await app.inject({ method: 'POST', url: '/__test/validation', payload: {} });
    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      error: { code: string; fields?: { issues?: unknown[] } };
    };
    expect(body.error.code).toBe('SCHEMA_VALIDATION');
    expect(body.error.fields?.issues).toEqual([
      { instancePath: '/name', message: 'must be string' },
    ]);
  });

  it('treats an empty validation list as an internal error', async () => {
    const res = await app.inject({ method: 'POST', url: '/__test/empty-validation', payload: {} });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INTERNAL');
  });

  it('maps the body-too-large error code to PAYLOAD_TOO_LARGE', async () => {
    const res = await app.inject({ method: 'POST', url: '/__test/too-large', payload: {} });
    expect(res.statusCode).toBe(413);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('emits an envelope for unmatched routes via the not-found handler', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/__no_such_route_anywhere__',
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toMatch(/^req-/);
  });
});
