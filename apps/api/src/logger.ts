/**
 * Process-wide pino instance. Now sourced from @aggregator-dpg/telemetry
 * so the same instance is shared with Fastify and so a single OTLP
 * transport ships records to the Collector.
 */

import { getLogger } from '@aggregator-dpg/telemetry';
import { config } from './config.js';

export const logger = getLogger({
  serviceName: 'aggregator-api',
  env: config.NODE_ENV,
  level: config.LOG_LEVEL,
  piiFieldsExcluded: ['user_message', 'phone', 'email'],
  otlpEnabled: !config.OTEL_SDK_DISABLED,
});
