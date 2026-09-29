import { driver, type DriveStep, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import './guide.css';
import type { GuideTour } from './tours';

/**
 * Plays a tour on the live page with Driver.js.
 *
 * Steps whose element is not on the page are dropped (or, with `keep`, shown
 * as a centred card) rather than pointing at nothing, so one tour copes with
 * empty states and config-gated controls.
 *
 * Ported from Signals-DPG `apps/ui/src/guide/run-tour.ts`; keep the two in
 * step.
 */

/** Give up waiting for anchors after this long and play what is there. */
const WAIT_MS = 6000;
/** After this long, settle for any anchor rather than all of them. */
const GRACE_MS = 1500;
const POLL_MS = 150;

let active: Driver | null = null;
let starting = false;

/** True while a tour is waiting to start or on screen. */
export function isTourRunning(): boolean {
  return starting || active !== null;
}

export async function runTour(tour: GuideTour): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    active?.destroy();
    // Pages render their content after data loads, so wait for the tour's
    // anchors to appear before deciding which steps to keep.
    await waitForAnchors(tour);

    const steps: DriveStep[] = tour.steps.flatMap((s) => {
      const element = firstVisible(s.element);
      if (s.element && !element && !s.keep) return [];
      const popover = { title: s.title, description: s.description };
      return [element ? { element, popover } : { popover }];
    });
    if (steps.length === 0) return;

    active = driver({
      steps,
      showProgress: true,
      allowClose: true,
      overlayOpacity: 0.55,
      stagePadding: 6,
      stageRadius: 10,
      popoverClass: 'bd-guide',
      onDestroyed: () => {
        active = null;
      },
    });
    active.drive();
  } finally {
    starting = false;
  }
}

async function waitForAnchors(tour: GuideTour): Promise<void> {
  // One entry per anchored step: a step is satisfied by any of its selectors.
  const selectors = tour.steps.flatMap((s) => (s.element ? [[s.element].flat().join(', ')] : []));
  if (selectors.length === 0) return;
  // Wait for every anchor, but a page state that lacks some of them (an empty
  // list, a config-gated button) settles for any anchor after a grace period.
  const startedAt = Date.now();
  while (Date.now() - startedAt < WAIT_MS) {
    if (selectors.every(isVisible)) return;
    if (Date.now() - startedAt > GRACE_MS && selectors.some(isVisible)) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function firstVisible(element: string | string[] | undefined): string | undefined {
  return [element ?? []].flat().find(isVisible);
}

function isVisible(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

const SEEN_PREFIX = 'bd:guide-seen:';

export function hasSeenTour(id: string): boolean {
  try {
    return localStorage.getItem(SEEN_PREFIX + id) !== null;
  } catch {
    return true; // storage blocked: never auto-start rather than nag every visit
  }
}

export function markTourSeen(id: string): void {
  try {
    localStorage.setItem(SEEN_PREFIX + id, new Date().toISOString());
  } catch {
    /* storage blocked — ignore */
  }
}
