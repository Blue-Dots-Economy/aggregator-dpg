/**
 * Voice campaign content schema and utilities.
 *
 * Defines the shape of voice request content, including agent configuration,
 * provider settings, and Raya start options for async execution.
 *
 * @module @aggregator-dpg/api
 */
import { z } from 'zod';

/**
 * Schema for the voice campaign request content.
 *
 * Accepts an agent ID, action type (dispatch only in v1), optional Raya provider,
 * batch name, variables, and Raya start-options passthrough fields.
 * Rejects unknown top-level keys via `.strict()`.
 */
export const voiceContentSchema = z
  .object({
    action: z.enum(['dispatch']).default('dispatch'),
    provider: z.enum(['raya']).optional(),
    agent_id: z.string().min(1),
    batch_name: z.string().min(1).max(200).optional(),
    variables: z.array(z.string().min(1)).optional(),
    // Raya start passthrough — forwarded verbatim, never defaulted:
    schedule: z.record(z.unknown()).optional(),
    max_retries: z.number().int().nonnegative().optional(),
    retry_after_hrs: z.number().nonnegative().optional(),
    max_concurrent_calls: z.number().int().positive().optional(),
    selected_statuses: z.array(z.string()).optional(),
  })
  .strict();

/** Inferred type from {@link voiceContentSchema}. */
export type VoiceContent = z.infer<typeof voiceContentSchema>;

const START_KEYS = [
  'schedule',
  'max_retries',
  'retry_after_hrs',
  'max_concurrent_calls',
  'selected_statuses',
] as const;

/**
 * Extracts Raya start options from voice content, returning only supplied keys.
 *
 * The returned object contains only the passthrough keys that are present in
 * the input, with their values unchanged. No defaults are injected.
 *
 * @param c - The parsed voice content.
 * @returns Record with only the supplied passthrough keys.
 */
export function voiceStartOptions(c: VoiceContent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of START_KEYS) if (c[k] !== undefined) out[k] = c[k];
  return out;
}
