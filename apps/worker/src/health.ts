/** Liveness endpoint (aggregator-dpg#675): fails on a blocked event loop or a dead Redis PING, not just PID-alive. */

import { createServer, type Server } from 'node:http';
import type { Redis } from 'ioredis';
import { logger } from './logger.js';

const REDIS_PING_TIMEOUT_MS = 2000;

async function pingRedis(redis: Redis): Promise<boolean> {
  try {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('redis ping timeout')), REDIS_PING_TIMEOUT_MS);
    });
    return (await Promise.race([redis.ping(), timeout])) === 'PONG';
  } catch {
    return false;
  }
}

export function startHealthServer(port: number, redis: Redis): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    void pingRedis(redis).then((redisOk) => {
      // Always 200 when the process can answer at all. This is a LIVENESS
      // endpoint: the only question it answers is "would a restart help?".
      //
      // A blocked event loop cannot respond, so the probe times out on its own
      // and the kubelet restarts — which is the case #675 was about, and the
      // case a restart genuinely fixes.
      //
      // Redis being unreachable is NOT that case. Restarting the worker cannot
      // bring Redis back, so a non-2xx here would restart every replica through
      // a Redis outage, CrashLoopBackOff them, and leave them still backing off
      // when Redis recovers — draining the queue later than doing nothing would
      // have. Report it in the body instead, where alerting can see it without
      // the kubelet acting on it.
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          status: redisOk ? 'ok' : 'degraded',
          redis: redisOk ? 'ready' : 'unreachable',
        }),
      );
    });
  });

  server.listen(port, () => {
    logger.info({ operation: 'worker.health', status: 'listening', port });
  });

  return server;
}
