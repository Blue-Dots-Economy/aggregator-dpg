'use client';

/**
 * Tells a component whether it is rendering in the browser (web app).
 *
 * @module apps/web/hooks/useIsClient
 */

import { useSyncExternalStore } from 'react';
import { subscribeNever } from '@/lib/subscribe-never';

/**
 * Returns `false` on the server and during hydration, then `true`.
 *
 * Use it to render a portal into `document.body`, which only exists in the
 * browser, without a hydration mismatch.
 *
 * @returns Whether `document` can be used in this render.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}
