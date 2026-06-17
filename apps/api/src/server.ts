/**
 * Process entrypoint. Builds the Fastify app and starts listening.
 */

import './env.js';
import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/client.js';
import { getNetworkConfig } from './services/network-config.js';
import { setApprovalBrand } from './views/approval-pages.js';
import { setEmailBrand } from './services/email-templates/shared.js';

async function main(): Promise<void> {
  // Boot guards: fail fast before accepting connections so per-request 500s
  // never mask misconfiguration.
  const approvalSecret = process.env.APPROVAL_TOKEN_SECRET ?? '';
  if (approvalSecret.length < 32) {
    logger.error(
      {
        operation: 'boot.guard',
        key: 'APPROVAL_TOKEN_SECRET',
        required_min: 32,
        actual: approvalSecret.length,
      },
      'APPROVAL_TOKEN_SECRET must be at least 32 chars; refusing to start',
    );
    process.exit(1);
  }
  if (config.SIGNALSTACK_BASE_URL && !config.SIGNALSTACK_ACTING_ORG_ID) {
    logger.error(
      { operation: 'boot.guard', key: 'SIGNALSTACK_ACTING_ORG_ID' },
      'SIGNALSTACK_ACTING_ORG_ID is required when SIGNALSTACK_BASE_URL is set',
    );
    process.exit(1);
  }

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
