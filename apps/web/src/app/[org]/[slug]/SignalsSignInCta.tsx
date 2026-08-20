'use client';

/**
 * Pre-form escape hatch (#652): the secondary option on the registration
 * chooser, for a participant who already has a Signals account and does not
 * want to fill the form.
 *
 * Distinct from the reactive `already_registered` alert, which fires on a
 * submit-attempt after the identity probe and offers edit-and-retry. This one
 * is proactive, sits in front of the form, and leaves the page.
 */

import { useTranslations } from 'next-intl';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';

/**
 * Resolve the Signals UI URL for this link, or `null` when the hand-off is off.
 *
 * Two independent gates, both config-driven:
 *  - the link's registration mode must have `signals_cta` (resolved
 *    server-side; defaults to full-profile modes only), and
 *  - the link's domain must have a URL in `signals_ui_urls`.
 *
 * `null` also means "no chooser": with nowhere to sign in there is nothing to
 * choose between, so the page renders the registration form directly.
 *
 * The returned value is a full URL configured by the operator — normally the
 * Signals UI's `/auth/login`, which mints a fresh Keycloak authorization URL
 * per attempt. A Keycloak URL configured here would carry one-time `state` and
 * `code_challenge` values and fail for every user; see the note in .env.example.
 *
 * @param domain - The link's domain id (e.g. `seeker`).
 * @param registrationMode - The link's registration mode key, or `null`.
 * @param submissionShape - The link's resolved submission shape, used only as
 *   the fallback when the mode is absent from the config.
 * @returns The configured Signals UI URL, or `null` when the CTA is off.
 */
export function useSignalsHandoffUrl(
  domain: string,
  registrationMode: string | null,
  submissionShape: 'account_only' | 'account_and_profile',
): string | null {
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const urls = cfg.signals_ui_urls;
  const url = urls && Object.hasOwn(urls, domain) ? urls[domain] : undefined;
  if (!url) return null;
  const modes = cfg.registration_modes;
  const mode =
    registrationMode && modes && Object.hasOwn(modes, registrationMode)
      ? modes[registrationMode]
      : undefined;
  // No declared mode (older api build, or a mode this network dropped) falls
  // back to the shape, matching the server-side default.
  const enabled = mode?.signals_cta ?? submissionShape === 'account_and_profile';
  return enabled ? url : null;
}

/**
 * Renders the "Already Registered — Sign In" option of the chooser.
 *
 * Deliberately secondary to the Register button next to it: outlined rather
 * than brand-filled, so the two options never read as equal primaries.
 *
 * @param props.href - Resolved Signals UI URL from {@link useSignalsHandoffUrl},
 *   used verbatim with nothing appended.
 * @returns The sign-in link, always opened in a new tab so the registration
 *   page survives behind it.
 */
export function SignalsSignInCta({ href }: Readonly<{ href: string }>) {
  const t = useTranslations('profile.public_reg');
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-full rounded-[12px] border border-(--bd-border) bg-white py-3 text-center font-display font-semibold text-[15px] text-ink-700 transition-colors hover:bg-(--bd-primary-50) hover:text-ink-900"
    >
      {t('signals_cta')}
    </a>
  );
}
