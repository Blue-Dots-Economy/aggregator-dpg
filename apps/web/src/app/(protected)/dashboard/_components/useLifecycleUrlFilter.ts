'use client';

/**
 * Lifecycle filter state kept in the dashboard URL (`web` app).
 */
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { parseLifecycleParam, type LifecycleFilterValue } from '../_lib/lifecycle';

/**
 * Lifecycle filter state stored in `?lifecycle=`.
 *
 * Updates the URL with `router.replace`. `'all'` removes the param.
 *
 * @returns The current value and a setter.
 */
export function useLifecycleUrlFilter(): [
  LifecycleFilterValue,
  (next: LifecycleFilterValue) => void,
] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = parseLifecycleParam(searchParams.get('lifecycle'));
  const setValue = (next: LifecycleFilterValue) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'all') params.delete('lifecycle');
    else params.set('lifecycle', next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return [value, setValue];
}
