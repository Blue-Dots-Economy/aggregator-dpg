'use client';

/**
 * Pre-submit escape hatch (#652): a tertiary link under the submit button for
 * a participant who already has a Signals account and does not want to fill
 * the form.
 *
 * Distinct from the reactive `already_registered` alert, which fires on a
 * submit-attempt after the identity probe and offers edit-and-retry. This one
 * is proactive and leaves the page.
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
  const url = cfg.signals_ui_urls?.[domain];
  if (!url) return null;
  const mode = registrationMode ? cfg.registration_modes?.[registrationMode] : undefined;
  // No declared mode (older api build, or a mode this network dropped) falls
  // back to the shape, matching the server-side default.
  const enabled = mode?.signals_cta ?? submissionShape === 'account_and_profile';
  return enabled ? url : null;
}

/**
 * Renders the "Already Registered — Sign In" link.
 *
 * @param props.href - Resolved Signals UI URL from {@link useSignalsHandoffUrl}.
 * @returns The CTA link, always opened in a new tab so a half-filled form survives.
 */
export function SignalsSignInCta({ href }: { href: string }) {
  const t = useTranslations('profile.public_reg');
  return (
    <div className="mt-4 text-center">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[13.5px] font-semibold text-ink-500 underline underline-offset-4 hover:text-ink-700"
      >
        {t('signals_cta')}
      </a>
    </div>
  );
}
