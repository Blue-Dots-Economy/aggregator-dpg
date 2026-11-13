/**
 * Text for a failed portal request (web app).
 *
 * Screens show this instead of an error's own message, so a response body
 * never reaches the user.
 */

import { useTranslations } from 'next-intl';
import { HttpError } from '../services/http';

/**
 * Whether a failed call was refused because the account does not serve the
 * profile type it asked for.
 *
 * @param err - The failure.
 */
export function isDomainNotServed(err: unknown): boolean {
  return err instanceof HttpError && err.code === 'DOMAIN_NOT_SERVED';
}

/**
 * Returns a function that turns a failed call into text to show: its own
 * message for a profile type the account does not serve, else `fallback`.
 */
export function useRequestErrorText(): (err: unknown, fallback: string) => string {
  const t = useTranslations('access');
  return (err, fallback) => (isDomainNotServed(err) ? t('domain_not_served') : fallback);
}
