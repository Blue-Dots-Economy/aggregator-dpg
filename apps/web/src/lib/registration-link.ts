/**
 * The public registration link as the web app reads it from the API (web app,
 * public registration). Used by the `[org]/[slug]` page and its view.
 */

import { IdentitySelectorsSchema } from '@aggregator-dpg/network-config/interface';
import { z } from 'zod';

/** Identity field names for a link's domain, used by the account-only form. */
export const LinkIdentitySchema = IdentitySelectorsSchema.partial();

/** Identity field names for a link's domain. */
export type LinkIdentity = z.infer<typeof LinkIdentitySchema>;

/**
 * The body of `GET /public/v1/aggregators/:org/links/:slug`, as the page reads
 * it. Fields the page can do without are optional.
 */
export const ResolveResponseSchema = z.object({
  /** Signalstack network id, for example `blue_dot`. */
  network: z.string().optional(),
  /** Domain id declared by the active network, for example `seeker`. */
  domain: z.string(),
  context: z.record(z.unknown()),
  /** JSON Schema for the link's domain. `null` for `account_only` links. */
  schema: z.unknown(),
  /** Identity field names for the domain, used by the account-only form. */
  identity: LinkIdentitySchema.optional(),
  /** Registration mode key, for example `voice` or `form`. */
  registration_mode: z.string().nullish(),
  /** Form shape. A missing or unknown value means `account_and_profile`. */
  submission_shape: z.enum(['account_only', 'account_and_profile']).optional().catch(undefined),
  /** i18n key for a hint shown under the public form. */
  public_hint_i18n_key: z.string().nullish(),
});
