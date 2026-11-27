/**
 * Whether the contact-support form is offered, read from the API for the
 * signed-in user. Used by the coordinator portal and the organisation console
 * layouts.
 *
 * @module apps/web/src/lib/support-enabled.server
 */

import { z } from 'zod';
import { callApi } from '@/lib/upstream-client';
import { logger } from '@/lib/logger';
import { summariseIssues } from '@/lib/response-shape-error';
import { errorMessage, errorType } from '@aggregator-dpg/shared-primitives/errors';

/** The body of `GET /v1/support/config`. */
const SupportConfigSchema = z.object({ enabled: z.boolean() });

/**
 * Fetches whether contact-support is enabled from `GET /v1/support/config`.
 *
 * Returns `false` on any upstream error, timeout, or unexpected response, and
 * logs why, so a hidden Contact support entry can be traced.
 *
 * @returns `true` if contact-support should be shown; `false` otherwise.
 */
export async function fetchSupportEnabled(): Promise<boolean> {
  try {
    const res = await callApi('/v1/support/config', { method: 'GET' });
    if (!res.ok) {
      logger.warn({
        operation: 'supportEnabled.fetch',
        status: 'failure',
        error: 'upstream responded with an error',
        http_status: res.status,
      });
      return false;
    }
    const parsed = SupportConfigSchema.safeParse(await res.json());
    if (parsed.success) return parsed.data.enabled;
    logger.warn({
      operation: 'supportEnabled.fetch',
      status: 'failure',
      error: 'unexpected response shape',
      issues: summariseIssues(parsed.error.issues),
    });
    return false;
  } catch (err) {
    logger.warn({
      operation: 'supportEnabled.fetch',
      status: 'failure',
      error: errorMessage(err),
      error_type: errorType(err),
    });
    return false;
  }
}
