/**
 * The network domains in `GET /v1/aggregator-config`, as the web server reads
 * them (web app). Used where only domain ids and labels are needed.
 */

import { z } from 'zod';

/** The `domains` list of the aggregator config: an id and, usually, a label. */
export const ConfigDomainsSchema = z.object({
  domains: z.array(z.object({ id: z.string(), label: z.string().optional() })),
});

/** One network domain with its display label. */
export interface DomainLabel {
  id: string;
  label: string;
}

/**
 * Reads the domain ids and labels from an aggregator-config body.
 *
 * @param body - The parsed response body.
 * @returns The domains in configuration order, each labelled with its id when it has no label; `null` when the body has the wrong shape.
 */
export function readDomainLabels(body: unknown): DomainLabel[] | null {
  const parsed = ConfigDomainsSchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.domains.map((d) => ({ id: d.id, label: d.label ?? d.id }));
}
