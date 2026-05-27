/**
 * observability-svc process entrypoint.
 *
 * Boot order:
 *   1. Load + validate config.
 *   2. Boot telemetry (patches HTTP modules).
 *   3. Connect Redis.
 *   4. Build the Fastify app and listen.
 *   5. Wire SIGTERM/SIGINT to flush telemetry, close app + redis, exit.
 *
 * @module observability-svc/main
 * @package @aggregator-dpg/observability-svc
 */

import { loadConfig } from './config.js';
import { bootObsTelemetry, shutdownObsTelemetry, meter } from './telemetry.js';
import { Redis } from 'ioredis';
import { buildServer } from './server.js';

/**
 * Main process entrypoint.
 *
 * Initialises all service dependencies in the correct boot order and
 * registers SIGINT/SIGTERM handlers for graceful shutdown.
 *
 * @returns A promise that resolves once the server is listening.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  await bootObsTelemetry(cfg);

  const redis = new Redis(cfg.REDIS_URL);
  const app = await buildServer({ config: cfg, redis, meter });

  await app.listen({ host: cfg.HOST, port: cfg.PORT });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await shutdownObsTelemetry();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
