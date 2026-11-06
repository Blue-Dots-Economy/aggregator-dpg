'use client';

import type { JSX } from 'react';
import { useTranslations } from 'next-intl';
import { I } from '@/icons';
import type { SignalsHandoff } from '../_lib/use-signals-handoff';

/** Props for {@link RegistrationDonePanel}. */
export interface RegistrationDonePanelProps {
  outcome: 'passed' | 'skipped';
  /** Submission reference; `''` hides the reference line. */
  submissionId: string;
  /** Running hand-off, or `null` when there is none. */
  handoff: SignalsHandoff | null;
  /** Brand colour of the hand-off button. */
  brandColor: string | undefined;
  /** Goes to Signals now. */
  onContinue: () => void;
  /** Clears the form for the next participant. */
  onRegisterAnother: () => void;
}

/**
 * Success panel shown after a submit succeeds, with the hand-off to Signals
 * when one is running.
 */
export function RegistrationDonePanel({
  outcome,
  submissionId,
  handoff,
  brandColor,
  onContinue,
  onRegisterAnother,
}: Readonly<RegistrationDonePanelProps>): JSX.Element {
  const t = useTranslations('profile.public_reg');
  /**
   * Visible label of the hand-off button, with the seconds left while counting.
   *
   * Shows the plain label once navigating. Visual only: the button's
   * accessible name is the plain label.
   */
  const continueLabel =
    handoff?.phase === 'counting' && handoff.seconds > 0
      ? t('btn_continue_to_signals_counting', { seconds: handoff.seconds })
      : t('btn_continue_to_signals');
  // Smaller top margin when the hand-off button is above "Register another".
  const registerAnotherSpacing = handoff ? 'mt-3' : 'mt-5';

  return (
    <div className="rounded-[14px] border border-emerald-200 bg-emerald-50 p-6">
      <div className="flex items-center gap-2.5 font-display font-bold text-[18px] text-emerald-800">
        <span className="w-7 h-7 rounded-full bg-emerald-500 text-white inline-flex items-center justify-center">
          <I.check size={16} stroke={2.6} />
        </span>
        {outcome === 'passed' ? t('done_passed_title') : t('done_skipped_title')}
      </div>
      <p className="text-[14px] text-emerald-700 mt-3 leading-relaxed">
        {outcome === 'passed' ? t('done_passed_body') : t('done_skipped_body')}
      </p>
      {submissionId ? (
        <div className="text-[11px] text-emerald-600/80 font-mono mt-3">
          {t('done_ref_prefix')} {submissionId}
        </div>
      ) : null}
      {/* Live region is always mounted so screen readers announce text
          added to it. It announces once, without the per-second count. */}
      <p aria-live="polite" className="sr-only">
        {handoff ? t('signals_redirect_announcement') : ''}
      </p>
      {handoff ? (
        <button
          type="button"
          onClick={onContinue}
          // Fixed accessible name so the per-second label is not announced.
          aria-label={t('btn_continue_to_signals')}
          style={{ backgroundColor: brandColor }}
          className="mt-5 w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white hover:opacity-90 transition-opacity"
        >
          <span aria-hidden="true">{continueLabel}</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={onRegisterAnother}
        // Secondary outline button, below the primary hand-off button.
        className={`${registerAnotherSpacing} w-full py-3 rounded-[12px] border border-(--bd-border) bg-white font-display font-bold text-[15px] text-ink-700 hover:bg-ink-50 transition-colors`}
      >
        {t('btn_register_another')}
      </button>
    </div>
  );
}
