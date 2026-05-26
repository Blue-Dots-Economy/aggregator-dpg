/**
 * observability-svc runtime configuration.
 *
 * Reads env vars (Zod-validated) plus JSON-encoded fields:
 *   - OUTCOMES_HMAC_SECRETS_JSON: map of keyId → secret
 *   - OUTCOME_METRICS_JSON:        catalogue of metrics to register (design §9)
 */

import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REDIS_URL: z.string(),
  // JSON map of HMAC keyId -> secret, e.g. {"svc-api":"...","svc-worker":"..."}
  OUTCOMES_HMAC_SECRETS_JSON: z.string(),
  ADMIN_TOKEN: z.string().min(16),
  APP_VERSION: z.string().default('dev'),
  IDEM_TTL_DAYS: z.coerce.number().int().positive().default(90),
  // Telemetry — this service emits OTel too
  OTEL_SDK_DISABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OTEL_COLLECTOR_ENDPOINT: z.string().default('http://otel-collector:4317'),
  OTEL_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1.0),
  // Outcome metric catalogue — JSON of design §9 outcomes.metrics
  OUTCOME_METRICS_JSON: z.string().default('[]'),
});

/** Definition of a single outcome metric driven by the catalogue config. */
export interface OutcomeMetricDef {
  name: string;
  instrument: 'counter' | 'histogram' | 'updown_counter';
  description?: string;
  unit?: string;
  attributes?: string[];
  /** Match an event name to apply this metric to. */
  on_event?: string;
}

/** Parsed and validated runtime configuration for observability-svc. */
export interface AppConfig {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  HOST: string;
  LOG_LEVEL: string;
  REDIS_URL: string;
  OUTCOMES_HMAC_SECRETS: Record<string, string>;
  ADMIN_TOKEN: string;
  APP_VERSION: string;
  IDEM_TTL_DAYS: number;
  OTEL_SDK_DISABLED: boolean;
  OTEL_COLLECTOR_ENDPOINT: string;
  OTEL_SAMPLE_RATE: number;
  OUTCOME_METRICS: OutcomeMetricDef[];
}

/**
 * Parses and validates environment variables into a typed AppConfig.
 *
 * @param env - Source of environment variables; defaults to `process.env`.
 * @returns A validated AppConfig with JSON fields decoded.
 * @throws {ZodError} If any required env var is missing or fails validation.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = Schema.parse(env);
  return {
    ...parsed,
    OUTCOMES_HMAC_SECRETS: JSON.parse(parsed.OUTCOMES_HMAC_SECRETS_JSON) as Record<string, string>,
    OUTCOME_METRICS: JSON.parse(parsed.OUTCOME_METRICS_JSON) as OutcomeMetricDef[],
  };
}
