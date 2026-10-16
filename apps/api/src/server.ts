/**
 * Process entrypoint. Builds the Fastify app and starts listening.
 */

import './env.js';
import { buildApp } from './app.js';
import { adminEmails, config, defaultOrgOwnerEmail } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/client.js';
import { closeRateLimiter } from './services/rate-limiter/index.js';
import { closeRedis } from './services/redis/index.js';
import { closeBulkQueue } from './services/bulk-queue/index.js';
import { closeCampaignProcessQueue } from './services/campaign-process-queue/index.js';
import { getNetworkConfig } from './services/network-config.js';
import {
  ensureRootOrganisation,
  mirrorRootOrganisations,
  rootConfigFrom,
  type RootState,
} from './services/organisation-root.js';
import { getIdpAdmin } from './services/idp-admin/index.js';
import { setApprovalBrand } from './views/approval-pages.js';
import { setEmailBrand } from './services/email-templates/shared.js';
import {
  loadEmailMessageOverrides,
  assertMessagesComplete,
} from './services/email-templates/messages.js';

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

  // Put the configured network root / Default-org values in place of the
  // placeholders 0028 seeds. Runs on every boot, whether or not this process
  // ran the migrations (existing instances migrate with the operator tool).
  // Never throws: a failure is logged and retried on the next boot. The IdP
  // mirror runs after `listen` (below), so Keycloak never delays readiness.
  let rootState: RootState | null = null;
  {
    let network: { urlSlug?: string; name?: string; legalName?: string | null } | null = null;
    try {
      const cfg = await getNetworkConfig();
      network = {
        urlSlug: cfg.aggregator.brand.url_slug,
        name: cfg.aggregator.name,
        legalName: cfg.aggregator.legal_name ?? null,
      };
    } catch {
      network = null; // logged above by the brand seed
    }
    rootState = await ensureRootOrganisation(
      rootConfigFrom(network, adminEmails, defaultOrgOwnerEmail()),
    );
  }

  // Externalised email copy: merge the network/brand/instance override layers
  // over the bundled defaults, then assert every key a case declares exists.
  // Overrides are best-effort (a missing layer is normal, an unreadable one is
  // logged and skipped) but a hole in the DEFAULTS is a build defect, so the
  // completeness check is allowed to stop boot rather than send blank emails.
  const overridden = await loadEmailMessageOverrides();
  assertMessagesComplete();
  logger.info({
    operation: 'emailMessages.init',
    status: 'success',
    overridden_keys: overridden,
  });

  const shutdown = (signal: string) => async () => {
    logger.info({ signal }, 'shutting down');
    try {
      // Drain HTTP first, then close every backing connection. The rate-limiter
      // Redis, the shared API Redis, and the BullMQ enqueue queue were all
      // previously leaked on SIGTERM (only Fastify + the PG pool were closed).
      await app.close();
      await closeDb();
      await Promise.allSettled([
        closeRateLimiter(),
        closeRedis(),
        closeBulkQueue(),
        closeCampaignProcessQueue(),
      ]);
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
    // Fire-and-forget: mirrorRootOrganisations never throws.
    if (rootState) void mirrorRootOrganisations(rootState, getIdpAdmin());
  } catch (err) {
    logger.error({ err }, 'failed to start api');
    process.exit(1);
  }
}

void main();
