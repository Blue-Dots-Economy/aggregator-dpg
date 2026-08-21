'use client';
/**
 * Blocking consent gate: every document in one continuous scroll, a progress
 * tracker above it, and a single agreement at the foot that unlocks only once
 * the reader has reached the end of the last document.
 *
 * Distinct from {@link ConsentModal}, which stays a dismissible read-only
 * viewer opened from inline links.
 *
 * @module apps/web/src/components/consent/ConsentGate
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, Check, X } from 'lucide-react';
import { MarkdownContent } from '../forms/MarkdownContent';
import { ConsentProgressTracker } from './ConsentProgressTracker';
import { useReadProgress } from './read-progress';
import type { ConsentDoc } from './consent-docs';

/** Props for {@link ConsentGate}. */
export interface ConsentGateProps {
  /** Whether the gate is showing. */
  open: boolean;
  /** Documents to read, in order. */
  docs: ConsentDoc[];
  /** Surface-specific agreement wording beside the checkbox. */
  agreeLabel: string;
  /** Called when the reader accepts. */
  onAccept: () => void;
  /** Optional deliberate exit. Omit to make the gate unexitable. */
  onCancel?: () => void;
}

/**
 * Renders the blocking consent gate.
 *
 * @param props - Open state, documents, agreement copy, and callbacks.
 * @returns The gate, or null when closed or there is nothing to show.
 */
export function ConsentGate({
  open,
  docs,
  agreeLabel,
  onAccept,
  onCancel,
}: ConsentGateProps): JSX.Element | null {
  // An empty list means the consent copy failed to load. Callers keep their
  // own fallback for that; an empty modal would be worse than none.
  if (!open || docs.length === 0) return null;

  // The dialog's own hooks (its ref, its `agreed` state, and — critically —
  // `useReadProgress`) must not exist until there is something for them to
  // measure. See {@link ConsentGateDialog}'s doc comment for why.
  return (
    <ConsentGateDialog
      docs={docs}
      agreeLabel={agreeLabel}
      onAccept={onAccept}
      onCancel={onCancel}
    />
  );
}

/** Props for {@link ConsentGateDialog}. */
interface ConsentGateDialogProps {
  docs: ConsentDoc[];
  agreeLabel: string;
  onAccept: () => void;
  // `| undefined` explicitly: exactOptionalPropertyTypes otherwise rejects
  // forwarding ConsentGate's own (also optional) `onCancel` prop verbatim,
  // since a destructured optional prop reads as `T | undefined`, not just `T`.
  onCancel?: (() => void) | undefined;
}

/**
 * The gate's actual dialog: tracker, reader, and footer. Rendered by
 * {@link ConsentGate} only while `open` — never always-mounted-but-hidden.
 *
 * That split is load-bearing, not cosmetic. `useReadProgress`'s mount effect
 * bails out immediately when `scrollRef.current` is `null`:
 *
 * ```ts
 * useEffect(() => {
 *   const el = scrollRef.current;
 *   if (!el) return; // taken here, forever, under the old always-mounted shape
 *   ...
 * }, [scrollRef, measure]);
 * ```
 *
 * When `ConsentGate` itself held this JSX and merely returned `null` while
 * closed, its hooks (this ref included) still ran on every render — closed
 * or open — because hooks cannot be conditional. The reader div only exists
 * in the DOM once `open` flips true, but by then `useReadProgress`'s mount
 * effect has already run once, against a `null` ref, and bailed. Because the
 * ref object and the memoised `measure` callback are otherwise stable across
 * re-renders (every caller memoises `docs`), that effect's dependency array
 * never changes, so it never re-runs — no scroll listener, no
 * `ResizeObserver`, `measure()` never called again. `progress` stays at
 * `initialProgress(docs)` (`allRead: false`) forever: the gate could not be
 * completed on any surface.
 *
 * Mounting this component fresh on every open means its ref is already
 * attached to the real reader element by the time `useReadProgress`'s mount
 * effect runs for the first (and only relevant) time — exactly how a
 * Radix/vaul-based dialog (the sibling Signals gate) avoids this: it mounts
 * its content on open rather than rendering it always, hidden.
 *
 * @param props - Documents, agreement copy, and callbacks.
 * @returns The dialog element.
 */
function ConsentGateDialog({
  docs,
  agreeLabel,
  onAccept,
  onCancel,
}: ConsentGateDialogProps): JSX.Element {
  const t = useTranslations('consent_gate');
  const readerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [agreed, setAgreed] = useState(false);
  const progress = useReadProgress(readerRef, docs);

  // Move focus into the dialog on mount, the same way ConsentModal does: a
  // hard-blocking modal that leaves focus wherever it was tells keyboard and
  // screen-reader users nothing opened. Prefer the close button when one
  // exists; otherwise the reader itself, since that is the only interactive
  // surface until the checkbox unlocks. No `open` guard needed here — this
  // component does not exist unless the gate is open.
  useEffect(() => {
    requestAnimationFrame(() => {
      if (onCancel) closeButtonRef.current?.focus();
      else readerRef.current?.focus();
    });
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-4">
      {/* Inert backdrop: present for the scrim only. Clicking it must not
          dismiss — losing a half-read consent flow by mis-tapping is worse
          than having to use the close button. */}
      <div data-testid="consent-gate-backdrop" className="absolute inset-0" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('title')}
        className="relative z-10 flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[20px] bg-white shadow-2xl sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-3 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wide text-(--bd-primary-600)">
              {t('eyebrow')}
            </p>
            <h2 className="mt-0.5 font-display text-xl font-bold leading-tight text-ink-900">
              {t('title')}
            </h2>
            <p className="mt-1 text-sm text-ink-500">{t('description')}</p>
          </div>
          {onCancel && (
            <button
              ref={closeButtonRef}
              type="button"
              aria-label={t('close')}
              onClick={onCancel}
              className="shrink-0 rounded-lg p-1.5 text-ink-500 transition-colors hover:bg-slate-100 hover:text-ink-900"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="shrink-0 px-4 pb-1 pt-3 sm:px-6">
          <ConsentProgressTracker docs={docs} progress={progress} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-5 pt-3 sm:px-6">
          <div
            ref={readerRef}
            data-testid="consent-reader"
            role="region"
            aria-label={t('reader_label')}
            // Focusable AND in the tab sequence (not just scrollable by
            // mouse/touch, and not `-1`): with no close button to land on,
            // this is where initial focus goes, and a focusable scroll
            // region is also a keyboard-scrollable one — necessary, since
            // the gate cannot be completed without scrolling it. `-1` would
            // still take initial focus but drop out of the tab sequence
            // entirely, so a keyboard user who tabs forward to the checkbox
            // could never tab back to keep scrolling — a trap the gate's own
            // completion requirement makes unrecoverable. A positive
            // tabIndex plus `role="region"` is the standard accessible
            // pattern for a scrollable region (WAI-ARIA APG "scrollable
            // region" pattern) — the lint rule's default allowlist just
            // doesn't include `region`.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            // `relative`: read-progress.ts measures each section via a
            // getBoundingClientRect delta, which is correct regardless of
            // which ancestor is positioned — this class isn't load-bearing
            // for that math. It's here anyway so this scroller is its own
            // positioning context, matching what a reader of this markup
            // would expect from `data-consent-section` children measured
            // against it, rather than leaving that an implicit accident of
            // the dialog panel above being `relative`.
            className="relative min-h-0 flex-1 overflow-y-auto rounded-xl border border-(--bd-border) bg-[#FBFCFF] p-4"
          >
            {docs.map((doc, i) => (
              <section
                key={doc.id}
                data-consent-section={doc.id}
                className={i > 0 ? 'mt-6 border-t border-slate-300 pt-5' : undefined}
              >
                <h3 className="mb-2 font-display text-[17px] font-bold text-ink-900">
                  {doc.title}
                </h3>
                <MarkdownContent content={doc.body} />
              </section>
            ))}
          </div>
        </div>

        <div className="mt-3 shrink-0 border-t border-(--bd-border) bg-[#FCFDFF] px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 sm:px-6">
          <p
            className={`flex items-center gap-1.5 text-[11.5px] ${
              progress.allRead ? 'font-semibold text-emerald-600' : 'text-ink-500'
            }`}
          >
            {progress.allRead ? (
              <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
            ) : (
              <ArrowDown className="h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            {progress.allRead ? t('hint_done') : t('hint_scroll')}
          </p>

          <label
            className={`mt-2.5 flex items-start gap-3 rounded-xl border p-3 transition-colors ${
              progress.allRead
                ? 'border-(--bd-primary-600) bg-white'
                : 'border-(--bd-border) bg-slate-50 opacity-60'
            }`}
          >
            <input
              type="checkbox"
              checked={agreed}
              disabled={!progress.allRead}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-[19px] w-[19px] shrink-0 accent-(--bd-primary-600)"
            />
            <span className="text-[13px] leading-relaxed text-ink-700">{agreeLabel}</span>
          </label>

          <button
            type="button"
            disabled={!progress.allRead || !agreed}
            onClick={onAccept}
            className="mt-3 w-full rounded-xl bg-(--bd-primary-600) py-3.5 text-[15px] font-bold text-white transition-colors disabled:bg-(--bd-primary-200) disabled:text-white"
          >
            {t('accept')}
          </button>
        </div>
      </div>
    </div>
  );
}
