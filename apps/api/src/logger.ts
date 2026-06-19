/**
 * Shared pino logger.
 *
 * Pretty multi-line output in dev; single-line JSON in production. Common
 * `service`/`env` fields are bound at the root so every line carries them.
 * Sensitive headers and body fields are redacted at serialisation time so
 * they never leak into the log stream.
 */

import pino from 'pino';
import { config } from './config.js';

const REDACT_PATHS = [
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
];

export const logger = pino({
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
          },
        },
      }
    : {}),
});
