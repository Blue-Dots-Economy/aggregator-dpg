/**
 * Shared pino logger for the api app.
 *
 * Pretty output in dev, JSON elsewhere. Every line carries `service` and `env`.
 * Secrets and PII fields are redacted.
 */

import pino from 'pino';
import { config } from './config.js';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  'body.password',
  'body.token',
  // Participant PII: email and phone must never be logged, at any of these nesting levels.
  'email',
  'phone',
  '*.email',
  '*.phone',
  '*.*.email',
  '*.*.phone',
];

/** File descriptor of stdout. */
const STDOUT_FD = 1;
/** File descriptor of stderr. */
const STDERR_FD = 2;

/**
 * Shared pino options, also used by the Fastify request logger so both apply the same redaction.
 */
export const loggerOptions: pino.LoggerOptions = {
  level: config.LOG_LEVEL,
  base: { service: 'aggregator-api', env: config.NODE_ENV },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  ...(config.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            singleLine: false,
            ignore: 'pid,hostname,service,env',
            destination: config.LOG_DESTINATION === 'stderr' ? STDERR_FD : STDOUT_FD,
          },
        },
      }
    : {}),
};

/** The shared logger; writes to stderr when `LOG_DESTINATION=stderr` (pretty output handles that itself). */
export const logger =
  config.LOG_DESTINATION === 'stderr' && config.NODE_ENV !== 'development'
    ? pino(loggerOptions, pino.destination({ fd: STDERR_FD, sync: true }))
    : pino(loggerOptions);

/**
 * Masks the `token` query parameter of a request URL, so invite links never reach the log.
 *
 * @param url - The request URL as Fastify reports it.
 * @returns The URL with every `token` value replaced.
 */
export function loggableUrl(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/g, '$1[REDACTED]');
}
