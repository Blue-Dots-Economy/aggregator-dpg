/**
 * Scroll-spy for the public legal page: tracks which rail entry to highlight
 * as the reader scrolls, lands on the URL fragment on arrival, and scrolls to
 * a rail entry when it is clicked.
 *
 * @module apps/web/src/components/legal/useLegalScrollSpy
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DOC_ORDER, firstPillId, type LaidOutGroup } from './legal-layout';

/**
 * A heading counts as "passed" once its top is within this distance of the
 * viewport top: the 80px `scroll-mt-20` offset plus slack.
 */
const READING_LINE_PX = 96;

/** Quiet time after the last scroll event before a click scroll counts as done. */
const SCROLL_SETTLE_MS = 150;

/** Returns whether the user prefers reduced motion. Checked on each call, not cached. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  );
}

/** Scrolls an element into view. Does nothing where `scrollIntoView` is missing (jsdom). */
function scrollElementIntoView(el: HTMLElement): void {
  el.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

/**
 * The rail entry for a heading id: a document heading maps to its first
 * section, any other id to itself.
 */
function pillFor(layout: readonly LaidOutGroup[], id: string): string {
  for (const group of layout) {
    for (const d of DOC_ORDER) {
      if (group.docs[d].headingId === id) return firstPillId(group.docs[d]);
    }
  }
  return id;
}

/** The first document's first rail entry, or `null` when there are no groups. */
function topPill(layout: readonly LaidOutGroup[]): string | null {
  const [first] = layout;
  const [firstDoc] = DOC_ORDER;
  return first && firstDoc ? firstPillId(first.docs[firstDoc]) : null;
}

/**
 * Tracks the highlighted rail entry for the laid-out page.
 *
 * @param layout - The laid-out groups; keep it stable between renders.
 * @returns The highlighted id and a function that scrolls to an id and highlights it.
 */
export function useLegalScrollSpy(layout: readonly LaidOutGroup[]): {
  activeSectionId: string | null;
  navigateTo: (id: string) => void;
} {
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);

  // All heading ids the scroll-spy tracks, in render order: each document
  // heading followed by its section ids.
  const allSpyIds = useMemo(
    () =>
      layout.flatMap((group) =>
        DOC_ORDER.flatMap((d) => [
          group.docs[d].headingId,
          ...group.docs[d].sections.map((s) => s.id),
        ]),
      ),
    [layout],
  );

  // Current highlight, readable inside `computeActiveId` without a dependency.
  const activeIdRef = useRef(activeSectionId);
  activeIdRef.current = activeSectionId;

  // Highlights the last heading whose top is at or above the reading line.
  // Uses heading positions, so short sections work correctly.
  const computeActiveId = useCallback((): string | null => {
    const elements = allSpyIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return activeIdRef.current;

    let lastPassed: HTMLElement | null = null;
    for (const el of elements) {
      if (el.getBoundingClientRect().top <= READING_LINE_PX) {
        lastPassed = el;
      } else {
        break;
      }
    }

    // At the top of the page: highlight the first document's first section.
    if (!lastPassed) return topPill(layout);
    return pillFor(layout, lastPassed.id);
  }, [allSpyIds, layout]);

  // During a click or arrival scroll the highlight is pinned to the target,
  // so it does not move through the sections the scroll passes.
  const pinnedIdRef = useRef<string | null>(null);
  const pinReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armPinRelease = useCallback(() => {
    if (pinReleaseTimerRef.current) clearTimeout(pinReleaseTimerRef.current);
    pinReleaseTimerRef.current = setTimeout(() => {
      pinnedIdRef.current = null;
      setActiveSectionId(computeActiveId());
    }, SCROLL_SETTLE_MS);
  }, [computeActiveId]);

  /**
   * Scrolls to `targetElId` and pins the highlight to `pillId` during the scroll.
   *
   * The two differ when the target is a document heading: the pill goes to its first section.
   */
  const scrollAndPin = useCallback(
    (targetElId: string, pillId: string) => {
      setActiveSectionId(pillId);
      pinnedIdRef.current = pillId;
      armPinRelease();
      const el = document.getElementById(targetElId);
      if (el) scrollElementIntoView(el);
    },
    [armPinRelease],
  );

  function navigateTo(id: string) {
    scrollAndPin(id, id);
  }

  // Arrival: scroll to the URL fragment if any. Also listens for `hashchange`
  // so in-page links to `/legal#...` scroll too. With no fragment, highlight
  // the first document's first section.
  useEffect(() => {
    if (layout.length === 0) return;

    function landOnHash() {
      const hashId =
        typeof window !== 'undefined' && window.location.hash
          ? decodeURIComponent(window.location.hash.slice(1))
          : null;

      if (hashId) {
        if (!document.getElementById(hashId)) return;
        // A document fragment scrolls to the document but highlights its first section.
        scrollAndPin(hashId, pillFor(layout, hashId));
        return;
      }

      // Already at the top; no scroll or pin needed.
      const fallbackPillId = topPill(layout);
      if (fallbackPillId) setActiveSectionId(fallbackPillId);
    }

    landOnHash();
    window.addEventListener('hashchange', landOnHash);
    return () => window.removeEventListener('hashchange', landOnHash);
  }, [layout, scrollAndPin]);

  // Recomputes the highlight on scroll and resize, unless it is pinned.
  useEffect(() => {
    if (allSpyIds.length === 0) return;

    function handleScroll() {
      if (pinnedIdRef.current) {
        // Still scrolling: push the pin release back.
        armPinRelease();
        return;
      }
      setActiveSectionId(computeActiveId());
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll);
    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [allSpyIds, computeActiveId, armPinRelease]);

  // Clear the pin timer on unmount.
  useEffect(() => {
    return () => {
      if (pinReleaseTimerRef.current) clearTimeout(pinReleaseTimerRef.current);
    };
  }, []);

  return { activeSectionId, navigateTo };
}
