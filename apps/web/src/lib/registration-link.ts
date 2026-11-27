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

/** The voice bot a link resolves to, as the public page shows it. */
export const LinkVoiceBotSchema = z.object({
  display_name: z.string(),
  /** The number the participant calls, shown before they register. */
  phone: z.string(),
  /** Language codes the bot speaks, as configured, for example `hi`. Show them with `languageNames`. */
  languages: z.array(z.string()),
  description: z.string().optional(),
});

/** The voice bot a link resolves to. */
export type LinkVoiceBot = z.infer<typeof LinkVoiceBotSchema>;

/** The channels this page knows how to offer. */
const LinkOfferSchema = z.enum(['voice', 'form']);

/** A channel this page knows how to offer. */
export type LinkOffer = z.infer<typeof LinkOfferSchema>;

/**
 * The body of `GET /public/v1/aggregators/:org/links/:slug`, as the page reads
 * it. Fields the page can do without are optional.
 */
export const ResolveResponseSchema = z.object({
  /** Signalstack network id, for example `blue_dot`. */
  network: z.string().optional(),
  /** Domain id declared by the active network, for example `seeker`. */
  domain: z.string(),
  context: z.record(z.string(), z.unknown()),
  /** JSON Schema for the link's domain. `null` for `account_only` links. */
  schema: z.unknown().optional(),
  /** Identity field names for the domain, used by the account-only form. */
  identity: LinkIdentitySchema.optional(),
  /** Registration mode key, for example `voice` or `form`. */
  registration_mode: z.string().nullish(),
  /** Form shape. A missing or unknown value means `account_and_profile`. */
  submission_shape: z.enum(['account_only', 'account_and_profile']).optional().catch(undefined),
  /** i18n key for a hint shown under the public form. */
  public_hint_i18n_key: z.string().nullish(),
  /**
   * Channels the page offers. Missing or malformed means the form only. Values
   * this page does not know yet (a later `callback`) are dropped, not rejected.
   */
  offers: z
    .array(z.unknown())
    .catch(['form'])
    .transform((list): LinkOffer[] => {
      const known = list.flatMap((o) => {
        const offer = LinkOfferSchema.safeParse(o);
        return offer.success ? [offer.data] : [];
      });
      return known.length > 0 ? known : ['form'];
    }),
  /** The link's voice bot; `null` when it offers no voice option. */
  voice_bot: LinkVoiceBotSchema.nullable().default(null),
});
