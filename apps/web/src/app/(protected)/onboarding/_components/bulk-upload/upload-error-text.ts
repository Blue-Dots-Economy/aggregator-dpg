import { ResponseShapeError } from '@/lib/response-shape-error';

/**
 * Text to show for a failed upload call.
 *
 * @param err - The failure.
 * @param unreadable - The message for a reply that could not be read.
 * @returns The plain message for an unreadable reply, else the error's own message.
 */
export function uploadErrorText(err: unknown, unreadable: string): string {
  if (err instanceof ResponseShapeError) return unreadable;
  return err instanceof Error ? err.message : String(err);
}
