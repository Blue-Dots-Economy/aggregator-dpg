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
      const status = redisOk ? 'ok' : 'unhealthy';
      res
        .writeHead(redisOk ? 200 : 503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ status, redis: redisOk ? 'ready' : 'unreachable' }));
    });
  });

  server.on('error', (err) => {
    logger.error({ operation: 'worker.health', status: 'failure', error: err.message });
  });

  server.listen(port, () => {
    logger.info({ operation: 'worker.health', status: 'listening', port });
  });

  return server;
}
