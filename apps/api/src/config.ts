/**
 * Runtime configuration loaded from environment variables.
 *
 * All values are read once at module init so request handlers stay pure.
 * Defaults target the local-dev compose stack; production overrides come
 * from `.env` or the orchestration layer.
 */

import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Comma-separated list of allowed CORS origins for the BFF and any future
   * direct browser clients. Use `*` only in dev.
   */
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3100'),
  /** Postgres connection string. Default points at the compose Postgres
   *  exposed on host port 5433 (5432 is left to system Postgres). */
  DATABASE_URL: z
    .string()
    .default('postgres://aggregator:aggregator-dev@localhost:5433/aggregator'),
  /** Run pending DB migrations on startup. Disable in CI/test to avoid races. */
  RUN_MIGRATIONS_ON_BOOT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Public origin of the API service; used to assemble admin email links. */
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  /** Public origin of the portal (BFF web app); used in welcome emails. */
  PUBLIC_PORTAL_URL: z.string().default('http://localhost:3000'),
  /** Comma-separated list of admin recipient email addresses. */
  ADMIN_EMAILS: z.string().default(''),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);

export const corsOrigins: string[] = config.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const adminEmails: string[] = config.ADMIN_EMAILS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
