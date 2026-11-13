/**
 * The "Registered, waiting to verify" section's anchor, shared by the server
 * list and the client count tiles (`apps/web`).
 *
 * @module apps/web/src/lib/waiting-to-verify
 */

/** The element id of the "Registered, waiting to verify" section. */
export const WAITING_TO_VERIFY_ID = 'waiting-to-verify';

/** Scrolls the "Registered, waiting to verify" section into view, when it is on the page. */
export function scrollToWaitingToVerify(): void {
  document.getElementById(WAITING_TO_VERIFY_ID)?.scrollIntoView({ behavior: 'smooth' });
}
