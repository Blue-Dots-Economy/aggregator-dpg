/**
 * Package-local pino logger for the consent-ledger service.
 *
 * Emits structured JSON. Log level is read from the `LOG_LEVEL` environment
 * variable at startup; defaults to `'info'`. All entries carry `service` and
 * `package` bindings so log aggregators can filter by source.
 *
 * @module @aggregator-dpg/consent-ledger
 */

import pino from 'pino';

/** Structured logger used by all concrete consent-ledger implementations. */
export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: {
    service: 'consent-ledger',
    package: '@aggregator-dpg/consent-ledger',
  },
});
