/** Tests for the /healthz liveness endpoint (aggregator-dpg#675). */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { Redis } from 'ioredis';
import { startHealthServer } from './health.js';

function fakeRedis(ping: () => Promise<string>): Redis {
  return { ping } as unknown as Redis;
}

async function get(server: Server, path: string): Promise<{ status: number; body: string }> {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const res = await fetch(`http://127.0.0.1:${address.port}${path}`);
  return { status: res.status, body: await res.text() };
}

describe('startHealthServer', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it('returns 200 when Redis responds PONG', async () => {
    server = startHealthServer(
      0,
      fakeRedis(async () => 'PONG'),
    );
    const { status, body } = await get(server, '/healthz');
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ status: 'ok', redis: 'ready' });
  });

  it('returns 503 when Redis ping rejects', async () => {
    server = startHealthServer(
      0,
      fakeRedis(async () => Promise.reject(new Error('down'))),
    );
    const { status, body } = await get(server, '/healthz');
    expect(status).toBe(503);
    expect(JSON.parse(body)).toEqual({ status: 'unhealthy', redis: 'unreachable' });
  });

  it('returns 503 when Redis ping never resolves (blocked/half-open)', async () => {
    server = startHealthServer(
      0,
      fakeRedis(() => new Promise(() => {})),
    );
    const { status } = await get(server, '/healthz');
    expect(status).toBe(503);
  }, 5000);

  it('returns 404 for any other path', async () => {
    server = startHealthServer(
      0,
      fakeRedis(async () => 'PONG'),
    );
    const { status } = await get(server, '/other');
    expect(status).toBe(404);
  });
});
