/**
 * Shared campaign request envelope (#579, API-contract normalization).
 *
 * Every campaign channel (export/email/voice) accepts the same request shape:
 *
 *   { "item_ids": string[], "metadata": [{ "key", "value" }], "content": {} }
 *
 * `item_ids` are the target Signals items. `metadata` is a free-form list of
 * `{key,value}` pairs stored verbatim on the job (no fixed allow-list — every
 * pair sent is persisted). `content` is the per-channel payload (empty `{}` for
 * export; the email/voice PRs give it a channel-specific shape).
 *
 * This module owns only the transport-shape validation. The per-request item
 * cap (`CAMPAIGN_<CHANNEL>_MAX_ITEMS`) is enforced in the route so it can return the
 * dedicated `CAMPAIGN_TOO_MANY_ITEMS` error instead of a generic 400.
 *
 * @module @aggregator-dpg/api
 */
import { z } from 'zod';

/** A single free-form metadata pair. */
export const campaignMetadataPairSchema = z
  .object({
    key: z.string().trim().min(1).max(200),
    value: z.string().max(2000),
  })
  .strict();

/**
 * The shared campaign request envelope. `item_ids` is validated as a non-empty
 * array of uuids here; the upper bound is applied in the route (dedicated
 * error). `metadata` and `content` default to empty so a minimal request is
 * just `{ "item_ids": [...] }`.
 */
export const campaignEnvelopeSchema = z
  .object({
    item_ids: z.array(z.string().uuid()).min(1),
    metadata: z.array(campaignMetadataPairSchema).max(50).default([]),
    content: z.record(z.unknown()).default({}),
  })
  .strict();

export type CampaignEnvelope = z.infer<typeof campaignEnvelopeSchema>;
export type CampaignMetadataPair = z.infer<typeof campaignMetadataPairSchema>;

/**
 * De-duplicates item ids while preserving first-seen order.
 *
 * @param ids - Raw item ids from the envelope.
 * @returns The ids with later duplicates removed, original order kept.
 */
export function dedupeItemIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Reads a metadata pair's value by key (first match), or undefined. Used by the
 * export path to surface a `purpose` pair in the notification email.
 *
 * @param metadata - The job's metadata pairs.
 * @param key - The key to look up.
 * @returns The matching value, or undefined.
 */
export function metadataValue(
  metadata: readonly CampaignMetadataPair[],
  key: string,
): string | undefined {
  return metadata.find((m) => m.key === key)?.value;
}
