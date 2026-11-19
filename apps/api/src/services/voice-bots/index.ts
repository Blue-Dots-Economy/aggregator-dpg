/**
 * Voice-bot resolution against the per-instance config.
 *
 * Pure helpers over {@link ResolvedNetworkConfig}: which bots serve a domain,
 * which one is the default, which one a link resolves to, and which
 * registration channels a mode offers.
 *
 * @module apps/api/services/voice-bots
 */

import type { ResolvedNetworkConfig, VoiceBot } from '@aggregator-dpg/network-config/interface';

/** A way a person can register through a link. */
export type RegistrationOffer = 'voice' | 'form';

/** What a mode offers when it declares no `offers`. */
const DEFAULT_OFFERS: readonly RegistrationOffer[] = ['form'];

/**
 * Lists the configured bots that serve a domain.
 *
 * @param domain - Network domain id.
 * @param cfg - The resolved network config.
 * @returns Bots whose `domains` include `domain`, in config order.
 */
export function botsForDomain(domain: string, cfg: ResolvedNetworkConfig): VoiceBot[] {
  return cfg.aggregator.voice_bots.filter((b) => b.domains.includes(domain));
}

/**
 * Finds the bot a domain uses when a link names none.
 *
 * It is the bot in `default_voice_bots`, else the only bot serving the domain.
 *
 * @param domain - Network domain id.
 * @param cfg - The resolved network config.
 * @returns The default bot, or `null` when there is none to choose.
 */
export function resolveDefaultVoiceBot(
  domain: string,
  cfg: ResolvedNetworkConfig,
): VoiceBot | null {
  const serving = botsForDomain(domain, cfg);
  const key = cfg.aggregator.default_voice_bots?.[domain];
  if (key !== undefined) return serving.find((b) => b.key === key) ?? null;
  const [only] = serving;
  return serving.length === 1 && only ? only : null;
}

/**
 * Resolves the bot a link points at.
 *
 * A key that is no longer configured, or whose bot does not serve the link's
 * domain, falls back to the domain default and reports `fellBack`.
 *
 * @param link - The link's stored bot key and domain.
 * @param cfg - The resolved network config.
 * @returns The bot (or `null` when none applies) and whether the key was replaced.
 */
export function resolveVoiceBot(
  link: { voiceBotKey: string | null; domain: string },
  cfg: ResolvedNetworkConfig,
): { bot: VoiceBot | null; fellBack: boolean } {
  const fallback = resolveDefaultVoiceBot(link.domain, cfg);
  if (link.voiceBotKey === null) return { bot: fallback, fellBack: false };
  const named = botsForDomain(link.domain, cfg).find((b) => b.key === link.voiceBotKey);
  return named ? { bot: named, fellBack: false } : { bot: fallback, fellBack: true };
}

/**
 * Lists the registration channels a mode offers.
 *
 * @param mode - Registration mode key.
 * @param cfg - The resolved network config.
 * @returns The mode's `offers`, or `['form']` when absent or the mode is undeclared.
 */
export function modeOffers(mode: string, cfg: ResolvedNetworkConfig): RegistrationOffer[] {
  return [...(cfg.aggregator.registration_modes[mode]?.offers ?? DEFAULT_OFFERS)];
}

/**
 * Tells whether a mode offers voice registration.
 *
 * @param mode - Registration mode key.
 * @param cfg - The resolved network config.
 */
export function modeOffersVoice(mode: string, cfg: ResolvedNetworkConfig): boolean {
  return modeOffers(mode, cfg).includes('voice');
}

/**
 * Finds the two-option mode: the first declared mode that offers both voice and the form.
 *
 * @param cfg - The resolved network config.
 * @param isEnabled - Skips modes this deployment does not enable; by default every mode counts.
 * @returns The mode key, or `null` when the network declares none that is enabled.
 */
export function twoOptionModeKey(
  cfg: ResolvedNetworkConfig,
  isEnabled: (mode: string) => boolean = () => true,
): string | null {
  const key = Object.keys(cfg.aggregator.registration_modes).find((mode) => {
    const offers = modeOffers(mode, cfg);
    return offers.includes('voice') && offers.includes('form') && isEnabled(mode);
  });
  return key ?? null;
}
