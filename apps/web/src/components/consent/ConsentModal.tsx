'use client';
/**
 * Read-only modal dialog showing the versioned Terms of Service or Privacy
 * Policy for a given audience.
 *
 * Opened via the clickable links in {@link ConsentCheckboxWidget}. Renders a
 * fixed full-screen overlay with two tabs (Terms / Privacy) and an accessible
 * close button. The modal traps ESC-key dismissal and is fully keyboard
 * accessible.
 *
 * @module apps/web/src/components/consent/ConsentModal
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MarkdownContent } from '../forms/MarkdownContent';
import type { ConsentDocContent } from './consent-types';

/** Which consent document tab is active inside {@link ConsentModal}. */
export type ConsentTab = 'terms' | 'privacy';

/** Props for {@link ConsentModal}. */
export interface ConsentModalProps {
  /** Whether the modal is currently visible. */
  open: boolean;
  /** Callback fired when the modal should be closed (sets open to false). */
  onOpenChange: (open: boolean) => void;
  /** Which tab should be active when the modal first opens. */
  initialTab: ConsentTab;
  /** Versioned consent document content to display. */
  content: ConsentDocContent;
}

/**
 * Displays a full-screen read-only modal containing the Terms of Service and
 * Privacy Policy, with tab navigation between them.
 *
 * Returns null when `open` is false to avoid mounting the heavy Markdown
 * renderer when the modal is not visible.
 *
 * @param props - Open state, change handler, initial tab, and document content.
 * @returns The modal overlay element, or null when closed.
 */
export function ConsentModal({
  open,
  onOpenChange,
  initialTab,
  content,
}: ConsentModalProps): JSX.Element | null {
  const t = useTranslations('register');
  const [activeTab, setActiveTab] = useState<ConsentTab>(initialTab);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Reset the active tab each time the modal opens.
  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
      // Move focus to the close button when the modal becomes visible.
      requestAnimationFrame(() => closeButtonRef.current?.focus());
    }
  }, [open, initialTab]);

  // Dismiss on ESC.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  const activeDoc = activeTab === 'terms' ? content.terms : content.privacy;

  return (
    /* Fixed full-screen overlay — the outer div is the backdrop; the inner div
       is the accessible dialog. Keyboard dismissal is handled via the ESC
       useEffect above; backdrop click is handled on the panel container using
       a button element. */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      {/* Invisible backdrop button captures click-outside-to-close. */}
      <button
        type="button"
        aria-label="Close consent dialog"
        className="absolute inset-0 cursor-default"
        onClick={() => onOpenChange(false)}
        tabIndex={-1}
      />
      {/* Dialog panel — sizing/layout mirrors the Signals-DPG consent modal
          (max-w-2xl, max-h-[90vh], flex column, no inner padding on the shell). */}
      <div
        className="relative z-10 w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-white shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={activeDoc.title}
      >
        {/* Header — generic eyebrow + title + description; the doc-specific
            heading comes from the Markdown content's own `##` heading, so it is
            not echoed here (matches the Signals-DPG consent modal). */}
        <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4 shrink-0">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--bd-primary)]">
              {t('consent.modal_eyebrow')}
            </p>
            <h2 className="font-display font-bold text-xl text-ink-900 leading-tight mt-0.5">
              {t('consent.modal_title')}
            </h2>
            <p className="text-sm text-ink-500 mt-1">{t('consent.modal_desc')}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-semibold text-ink-500 hover:text-ink-900 hover:bg-slate-100 transition-colors"
            onClick={() => onOpenChange(false)}
          >
            {t('consent.modal_close')}
          </button>
        </div>

        {/* Tabs + scrollable content region */}
        <div className="flex flex-col flex-1 overflow-hidden px-6 pb-6 gap-4">
          {/* Pill tab bar — gray track, white active pill (shadcn-style). */}
          <div className="flex w-full shrink-0 h-11 p-1 gap-1 rounded-lg bg-slate-100">
            {(['terms', 'privacy'] as const).map((tab) => {
              const label = tab === 'terms' ? content.terms.title : content.privacy.title;
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 flex items-center justify-center rounded-md text-[13.5px] font-semibold transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-white text-[var(--bd-primary)] shadow-sm'
                      : 'text-ink-500 hover:text-ink-800'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Content — scrollable */}
          <div className="flex-1 overflow-y-auto pr-1">
            <MarkdownContent content={activeDoc.content} />
          </div>
        </div>
      </div>
    </div>
  );
}
