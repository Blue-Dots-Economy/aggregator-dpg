/**
 * Process entrypoint. Boots telemetry FIRST so OTel can patch Fastify and
 * undici before they are loaded. All modules that import Fastify, BullMQ,
 * or any HTTP client live behind a dynamic `import()` so OTel's
 * require-in-the-middle hooks fire before those packages enter the module
 * cache — otherwise the auto-instrumentation patches never apply.
 */

import './env.js';
import { bootApiTelemetry, shutdownApiTelemetry } from './telemetry.js';

await bootApiTelemetry();

// Dynamic imports — must come AFTER bootApiTelemetry() so OTel's
// instrumentation patches install before Fastify / pg / undici are required.
const { buildApp } = await import('./app.js');
const { config } = await import('./config.js');
const { logger } = await import('./logger.js');
const { runMigrations } = await import('./db/migrate.js');
const { closeDb } = await import('./db/client.js');
const { getNetworkConfig } = await import('./services/network-config.js');
const { setApprovalBrand } = await import('./views/approval-pages.js');
const { setEmailBrand } = await import('./services/email-templates/shared.js');

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

  // Seed the admin-approval HTML pages with the active deployment's
  // brand so the email-triggered approve/reject flow renders the same
  // logo + palette as the portal. Network config is cached, so this is
  // cheap and only runs once.
  try {
    const cfg = await getNetworkConfig();
    setApprovalBrand({
      short_name: cfg.aggregator.brand.short_name,
      long_name: cfg.aggregator.brand.long_name,
      primary_color: cfg.aggregator.brand.primary_color ?? '#4f46e5',
      portal_url: process.env.PUBLIC_PORTAL_URL ?? 'http://localhost:3000',
    });
    setEmailBrand({
      short_name: cfg.aggregator.brand.short_name,
      long_name: cfg.aggregator.brand.long_name,
      primary_color: cfg.aggregator.brand.primary_color ?? '#4f46e5',
    });
  } catch (err) {
    logger.warn({ err }, 'approval brand seed failed — falling back to default');
  }

  const shutdown = (signal: string) => async () => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await shutdownApiTelemetry();
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
