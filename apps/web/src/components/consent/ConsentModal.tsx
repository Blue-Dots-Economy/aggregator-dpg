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
      {/* Dialog panel */}
      <div
        className="relative z-10 w-full max-w-2xl max-h-[80vh] flex flex-col rounded-[16px] bg-white shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={activeDoc.title}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
          <h2 className="font-display font-bold text-[18px] text-ink-900 leading-tight">
            {activeDoc.title}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="ml-4 shrink-0 rounded-[8px] px-3 py-1.5 text-[13px] font-semibold text-ink-500 hover:text-ink-900 hover:bg-slate-100 transition-colors"
            onClick={() => onOpenChange(false)}
          >
            {t('consent.modal_close')}
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-6 pt-3 pb-0 border-b border-slate-100 bg-white">
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
                className={`px-4 py-2 mb-[-1px] text-[13.5px] font-semibold rounded-t-[6px] border-b-2 transition-colors cursor-pointer ${
                  isActive
                    ? 'border-[var(--bd-primary)] text-[var(--bd-primary)]'
                    : 'border-transparent text-ink-500 hover:text-ink-800'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Content — scrollable */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <MarkdownContent content={activeDoc.content} />
        </div>
      </div>
    </div>
  );
}
