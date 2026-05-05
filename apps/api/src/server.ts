/**
 * Process entrypoint. Builds the Fastify app and starts listening.
 */

import './env.js';
import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/client.js';

async function main(): Promise<void> {
  if (config.RUN_MIGRATIONS_ON_BOOT) {
    try {
      await runMigrations();
    } catch (err) {
      logger.error({ err }, 'failed to run migrations on boot');
      process.exit(1);
    }
  }

  const app = await buildApp();

  const shutdown = (signal: string) => async () => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeDb();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    logger.info({ host: config.HOST, port: config.PORT }, 'api listening');
  } catch (err) {
    logger.error({ err }, 'failed to start api');
    process.exit(1);
  }
}

void main();
