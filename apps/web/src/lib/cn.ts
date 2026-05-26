import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Tailwind-aware class merger. clsx handles conditional joins, then
 * twMerge dedupes conflicting Tailwind utilities so a later
 * `bg-red-500` wins over an earlier `bg-blue-500` instead of both
 * landing in the className string.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
