'use client';

/**
 * Reads the contact-support attachment limits from the BFF (web app).
 *
 * The support dialog shows these limits and checks a selection against them
 * before upload. The API checks again on submit.
 *
 * @module apps/web/hooks/useSupportConfig
 */

import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ResponseShapeError, jsonFetch } from '@/services/http';
import { SUPPORT_CONFIG_FALLBACK, type SupportConfig } from '@/lib/support-attachments';

const SUPPORT_CONFIG_URL = '/api/support/config';

/** The `GET /v1/support/config` reply, as in the API's `openapi.json`. */
const SupportConfigSchema = z.object({
  enabled: z.boolean(),
  maxTotalBytes: z.number().int().positive(),
  maxFiles: z.number().int().positive(),
  allowedTypes: z.array(z.string()),
  allowedExtensions: z.array(z.string()).default([]),
});

/**
 * Fetches the limits and logs a failure before passing it on.
 *
 * @throws {ResponseShapeError} When the reply does not match the schema.
 * @throws {Error} When the request fails.
 */
async function fetchSupportConfig(signal: AbortSignal): Promise<SupportConfig> {
  try {
    return await jsonFetch(SUPPORT_CONFIG_URL, SupportConfigSchema, { signal });
  } catch (err) {
    if (!signal.aborted) {
      console.warn('[support-config] fetch failed; the default attachment limits apply', {
        operation: 'support-config.fetch',
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof ResponseShapeError ? { issues: err.issueSummary() } : {}),
      });
    }
    throw err;
  }
}

/**
 * Returns the attachment limits the API serves.
 *
 * Returns `SUPPORT_CONFIG_FALLBACK` while loading and after a failed read.
 *
 * @returns The limits to apply.
 */
export function useSupportConfig(): SupportConfig {
  const { data } = useQuery({
    queryKey: ['support-config'],
    queryFn: ({ signal }) => fetchSupportConfig(signal),
  });
  return data ?? SUPPORT_CONFIG_FALLBACK;
}
