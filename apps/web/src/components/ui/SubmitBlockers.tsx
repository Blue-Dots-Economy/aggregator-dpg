'use client';

import type { ReactNode } from 'react';
import { I } from '../../icons';

/**
 * Inline "why is submit disabled" hint. Pairs with a gated submit button so a
 * disabled button always explains itself — without this the button looks
 * clickable but silently swallows the click (e.g. an invalid mobile number the
 * user can't see is the blocker).
 *
 * Renders nothing when `reasons` is empty (form is submittable). Each reason is
 * a short, user-facing sentence describing one unmet requirement.
 */
export function SubmitBlockers({
  reasons,
  heading,
}: {
  reasons: string[];
  /** Optional lead-in line, e.g. "To create the link:". */
  heading?: ReactNode;
}): JSX.Element | null {
  if (reasons.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800"
    >
      <div className="flex items-start gap-2">
        <I.alert size={14} className="mt-0.5 shrink-0 text-amber-600" />
        <div>
          {heading && <div className="font-semibold mb-0.5">{heading}</div>}
          <ul className="list-disc pl-4 space-y-0.5">
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
