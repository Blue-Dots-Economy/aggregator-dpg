'use client';
/**
 * Progress tracker for {@link ConsentGate}: one dot per document, joined by a
 * line that fills as the reader advances.
 *
 * Presentational only — all state arrives via `progress`.
 *
 * @module apps/web/src/components/consent/ConsentProgressTracker
 */
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ConsentDoc } from './consent-docs';
import type { ReadProgress } from './read-progress';

/** Props for {@link ConsentProgressTracker}. */
export interface ConsentProgressTrackerProps {
  docs: ConsentDoc[];
  progress: ReadProgress;
}

/**
 * Renders the per-document progress dots and the connecting fill line.
 *
 * @param props - Documents in order plus current read progress.
 * @returns The tracker, or null when there are fewer than two documents.
 */
export function ConsentProgressTracker({
  docs,
  progress,
}: ConsentProgressTrackerProps): JSX.Element | null {
  const t = useTranslations('consent_gate');

  // A tracker with one node reports nothing the reader cannot already see.
  if (docs.length < 2) return null;

  return (
    <div className="relative mx-auto flex max-w-[340px] items-start justify-between px-1.5 pt-0.5">
      <div className="absolute left-[16.67%] right-[16.67%] top-[9px] h-0.5 overflow-hidden rounded-sm bg-slate-300">
        <div
          data-testid="consent-progress-fill"
          className="h-full bg-(--bd-primary-600) transition-[width] duration-100 ease-linear"
          style={{ width: `${progress.fillPercent}%` }}
        />
      </div>
      {docs.map((doc) => {
        const state = progress.readIds.includes(doc.id)
          ? 'read'
          : doc.id === progress.currentId
            ? 'current'
            : 'todo';
        // The i18n key is added in a later task; until then this falls back
        // to the hardcoded `cap` so the tracker still renders a label.
        const capKey = `cap_${doc.id}`;
        const label = t.has(capKey) ? t(capKey) : doc.cap;
        return (
          <div
            key={doc.id}
            data-testid={`consent-node-${doc.id}`}
            data-consent-node={doc.id}
            data-state={state}
            className="relative z-10 flex flex-1 flex-col items-center gap-1.5"
          >
            <span
              className={`grid h-5 w-5 place-items-center rounded-full border-2 transition-colors ${
                state === 'read'
                  ? 'border-(--bd-primary-600) bg-(--bd-primary-600)'
                  : state === 'current'
                    ? 'border-(--bd-primary-600) bg-white ring-4 ring-(--bd-primary-600)/20'
                    : 'border-slate-300 bg-white'
              }`}
            >
              {state === 'read' && <Check className="h-3 w-3 text-white" aria-hidden="true" />}
            </span>
            <span
              className={`text-[10.5px] font-semibold ${
                state === 'todo' ? 'text-ink-500' : 'text-ink-900'
              }`}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
