/**
 * A `useSyncExternalStore` subscription for values that never change while the
 * page is open (web app).
 *
 * @module apps/web/lib/subscribe-never
 */

/**
 * Subscribes to nothing; React reads the snapshot on each render.
 *
 * @returns An unsubscribe function that does nothing.
 */
export function subscribeNever(): () => void {
  return () => {};
}
