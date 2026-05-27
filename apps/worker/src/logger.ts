/**
 * Worker logger. Now sourced from @aggregator-dpg/telemetry so the
 * shared pino instance carries trace_id/span_id and ships records to
 * the Collector when OTLP is enabled.
 */

import { getLogger } from '@aggregator-dpg/telemetry';
import { config } from './config.js';

export const logger = getLogger({
  serviceName: 'aggregator-worker',
  env: config.NODE_ENV,
  level: config.LOG_LEVEL,
  piiFieldsExcluded: ['user_message', 'phone', 'email'],
  otlpEnabled: !config.OTEL_SDK_DISABLED,
});
