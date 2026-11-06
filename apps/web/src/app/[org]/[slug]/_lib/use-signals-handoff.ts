/**
 * Post-submit hand-off countdown to the Signals UI (web app, public registration).
 */
import { useEffect, useRef, useState } from 'react';

/**
 * Seconds before the post-submit hand-off to Signals.
 *
 * The success panel is the only place the submission reference id is shown,
 * so this gives the participant time to read it before the page navigates away.
 */
export const SIGNALS_REDIRECT_SECONDS = 4;

/**
 * State of the post-submit hand-off countdown.
 *
 * The URL is captured when the countdown starts, so a config refetch during
 * the countdown cannot clear or change it. The countdown moves to
 * `navigating` once, and the navigation runs when that phase is reached.
 */
export type SignalsHandoff =
  { phase: 'counting'; url: string; seconds: number } | { phase: 'navigating'; url: string };

/**
 * Sends the participant to the Signals UI in the same tab.
 *
 * Do not use `window.open(url, '_blank')`: this runs from a timer, and
 * browsers block pop-ups opened without a user click. Errors from a blocked
 * navigation are logged; the button stays on screen.
 *
 * @param url - Hand-off URL captured when the countdown started.
 */
function navigateToSignals(url: string): void {
  try {
    window.location.assign(url);
  } catch (err) {
    console.error(
      '[signals-handoff] navigation to the Signals UI was blocked; the participant stays on the success panel',
      {
        operation: 'signals-handoff.navigate',
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

/**
 * The next countdown state after one second.
 *
 * Only a running countdown moves, so a tick that lands after a cancel keeps
 * the cancel.
 *
 * @param prev - The current state.
 */
function tick(prev: SignalsHandoff | null): SignalsHandoff | null {
  if (prev?.phase !== 'counting') return prev;
  if (prev.seconds <= 1) return { phase: 'navigating', url: prev.url };
  return { ...prev, seconds: prev.seconds - 1 };
}

/** What {@link useSignalsHandoff} returns. */
export interface SignalsHandoffControls {
  /** `null` when no countdown is running. */
  handoff: SignalsHandoff | null;
  /**
   * Starts the countdown to the latest hand-off URL. Does nothing when there
   * is no URL. A running countdown is kept as is.
   */
  start: () => void;
  /** Stops the countdown without navigating. */
  cancel: () => void;
  /** Stops a running countdown and navigates now. Does nothing once navigating. */
  continueNow: () => void;
}

/**
 * Runs the post-submit countdown and navigates to Signals when it ends.
 *
 * @param url - Current hand-off URL, or `null` when the hand-off is not configured.
 * @returns The countdown state and its controls.
 */
export function useSignalsHandoff(url: string | null): SignalsHandoffControls {
  const [handoff, setHandoff] = useState<SignalsHandoff | null>(null);
  // Latest URL for `start`, which runs after an awaited submit and so would
  // otherwise see the URL from the render that began the submit.
  const latestUrlRef = useRef(url);

  useEffect(() => {
    latestUrlRef.current = url;
  }, [url]);

  useEffect(() => {
    if (handoff?.phase !== 'counting') return;
    const timer = setTimeout(() => setHandoff(tick), 1000);
    return () => clearTimeout(timer);
  }, [handoff]);

  useEffect(() => {
    if (handoff?.phase === 'navigating') navigateToSignals(handoff.url);
  }, [handoff]);

  return {
    handoff,
    start: () => {
      const target = latestUrlRef.current;
      if (!target) return;
      setHandoff(
        (prev) => prev ?? { phase: 'counting', url: target, seconds: SIGNALS_REDIRECT_SECONDS },
      );
    },
    cancel: () => setHandoff(null),
    continueNow: () => {
      // Once navigating, the navigation has already run.
      if (handoff?.phase !== 'counting') return;
      // Stop the countdown first so it does not navigate a second time.
      setHandoff(null);
      navigateToSignals(handoff.url);
    },
  };
}
