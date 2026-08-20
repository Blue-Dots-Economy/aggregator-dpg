/**
 * Resolves a per-link `registration_mode` key to its runtime form shape
 * via the live network config. Unknown keys fall back to
 * `account_and_profile` so a config drift (mode key removed but live
 * links still reference it) never blows up; the worst case is the link
 * renders the full form by accident.
 *
 * Single source of truth: aggregator.config.yaml under
 * `aggregator.registration_modes`. The DB column is just a key.
 */
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';

export type SubmissionShape = 'account_only' | 'account_and_profile';

export function resolveSubmissionShape(mode: string, cfg: ResolvedNetworkConfig): SubmissionShape {
  const modes = cfg.aggregator.registration_modes ?? {};
  return modes[mode]?.submission_shape ?? 'account_and_profile';
}

export function isModeDeclared(mode: string, cfg: ResolvedNetworkConfig): boolean {
  const modes = cfg.aggregator.registration_modes ?? {};
  return Object.prototype.hasOwnProperty.call(modes, mode);
}

export function publicHintI18nKey(mode: string, cfg: ResolvedNetworkConfig): string | null {
  const modes = cfg.aggregator.registration_modes ?? {};
  return modes[mode]?.public_hint_i18n_key ?? null;
}

/**
 * Whether links in this mode offer the Signals UI hand-off.
 *
 * Defaults off the *resolved* submission shape rather than off the raw config,
 * so an undeclared mode — which already renders the full profile form via
 * {@link resolveSubmissionShape}'s fallback — behaves like `form` here too.
 */
export function signalsCtaEnabled(mode: string, cfg: ResolvedNetworkConfig): boolean {
  const modes = cfg.aggregator.registration_modes ?? {};
  const explicit = modes[mode]?.signals_cta;
  if (typeof explicit === 'boolean') return explicit;
  return resolveSubmissionShape(mode, cfg) === 'account_and_profile';
}
