'use client';

import type { JSX } from 'react';
import { useTranslations } from 'next-intl';
import { I } from '@/icons';
import { SignalsSignInCta } from '../SignalsSignInCta';

/** Props for {@link RegistrationChooser}. */
export interface RegistrationChooserProps {
  /** Signals sign-in URL for participants who already registered. */
  signalsUrl: string;
  /** Brand colour of the Register button. */
  brandColor: string | undefined;
  /** Shows the registration form. */
  onRegister: () => void;
}

/**
 * Chooser between Register and Sign in, shown before the form when the
 * Signals hand-off is configured.
 */
export function RegistrationChooser({
  signalsUrl,
  brandColor,
  onRegister,
}: Readonly<RegistrationChooserProps>): JSX.Element {
  const t = useTranslations('profile.public_reg');
  return (
    <div data-testid="registration-chooser">
      <h2 className="font-display font-bold text-[19px] text-(--bd-fg) tracking-tight">
        {t('chooser_title')}
      </h2>
      <p className="mt-2 text-[14px] text-ink-500 leading-relaxed">{t('chooser_subtitle')}</p>
      <div className="mt-5 flex flex-col gap-3">
        <button
          type="button"
          onClick={onRegister}
          style={{ backgroundColor: brandColor }}
          className="w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white hover:opacity-90 transition-opacity bd-shadow-lg"
        >
          {t('chooser_register_cta')}
        </button>
        <SignalsSignInCta href={signalsUrl} />
      </div>
    </div>
  );
}

/**
 * Button that goes back from the form to the chooser.
 */
export function BackToChooserButton({ onBack }: Readonly<{ onBack: () => void }>): JSX.Element {
  const t = useTranslations('profile.public_reg');
  return (
    <button
      type="button"
      onClick={onBack}
      className="mb-4 inline-flex items-center gap-1 text-[13px] font-semibold text-ink-500 hover:text-ink-700"
    >
      <I.arrowL size={14} />
      {t('chooser_back')}
    </button>
  );
}
