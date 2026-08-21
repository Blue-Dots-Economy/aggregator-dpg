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

/** How one document's dot renders: read, currently in hand, or not yet reached. */
type NodeState = 'read' | 'current' | 'todo';

/**
 * Classifies one document's tracker node against current read progress.
 *
 * @param docId - The document's id.
 * @param progress - Current read progress across the whole stack.
 * @returns Whether the node is read, current, or still to do.
 */
function nodeState(docId: string, progress: ReadProgress): NodeState {
  if (progress.readIds.includes(docId)) return 'read';
  if (docId === progress.currentId) return 'current';
  return 'todo';
}

/**
 * Dot styling per node state. A keyed record rather than a conditional chain,
 * so adding a state is a type error here instead of silently taking `todo`.
 */
const DOT_CLASS: Record<NodeState, string> = {
  read: 'border-(--bd-primary-600) bg-(--bd-primary-600)',
  current: 'border-(--bd-primary-600) bg-white ring-4 ring-(--bd-primary-600)/20',
  todo: 'border-slate-300 bg-white',
};

/**
 * Renders the per-document progress dots and the connecting fill line.
 *
 * @param props - Documents in order plus current read progress.
 * @returns The tracker, or null when there are fewer than two documents.
 */
export function ConsentProgressTracker({
  docs,
  progress,
}: Readonly<ConsentProgressTrackerProps>): JSX.Element | null {
  const t = useTranslations('consent_gate');

  // A tracker with one node reports nothing the reader cannot already see.
  if (docs.length < 2) return null;

  // The line spans from the first dot's centre to the last dot's centre.
  // Each dot sits in its own `flex-1` node, so with `n` equal-width nodes,
  // node `i`'s centre (0-indexed) is at `(i + 0.5) / n`; the first dot's
  // centre is therefore `0.5 / n` = `50 / n` percent from the left, and the
  // last dot's centre is the same distance from the right. `16.67%` was
  // `50 / 3`, hardcoded for exactly three nodes — correct only there. With
  // two nodes the true centres are at 25%/75%, so that hardcoded 16.67%
  // reached past both dots. Computing it from `docs.length` keeps both node
  // counts correct instead of just the one this happened to be built for.
  const inset = 50 / docs.length;

  return (
    <div className="relative flex w-full items-start justify-between px-1.5 pt-0.5">
      <div
        data-testid="consent-progress-track"
        className="absolute top-[9px] h-0.5 overflow-hidden rounded-sm bg-slate-300"
        style={{ left: `${inset}%`, right: `${inset}%` }}
      >
        <div
          data-testid="consent-progress-fill"
          className="h-full bg-(--bd-primary-600) transition-[width] duration-100 ease-linear"
          style={{ width: `${progress.fillPercent}%` }}
        />
      </div>
      {docs.map((doc) => {
        const state = nodeState(doc.id, progress);
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
              className={`grid h-5 w-5 place-items-center rounded-full border-2 transition-colors ${DOT_CLASS[state]}`}
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
