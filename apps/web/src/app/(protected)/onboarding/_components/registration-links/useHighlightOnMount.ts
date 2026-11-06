'use client';

import { useEffect, useRef, useState } from 'react';

/** How long the ring stays on a just-created card. */
const HIGHLIGHT_RING_MS = 2000;

/**
 * Scrolls a just-created card into view and shows a ring for `HIGHLIGHT_RING_MS`.
 *
 * @returns The card ref and whether the ring is shown.
 */
export function useHighlightOnMount(highlight: boolean) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [ringed, setRinged] = useState(highlight);
  useEffect(() => {
    if (!highlight) return;
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timer = setTimeout(() => setRinged(false), HIGHLIGHT_RING_MS);
    return () => clearTimeout(timer);
  }, [highlight]);
  return { cardRef, ringed };
}
