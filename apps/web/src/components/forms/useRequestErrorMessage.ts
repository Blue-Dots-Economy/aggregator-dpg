'use client';

/**
 * Turns a failed request into one translated sentence (`@aggregator-dpg/web`).
 *
 * @module apps/web/src/components/forms/useRequestErrorMessage
 */

import { useTranslations } from 'next-intl';
import { requestErrorCode, requestErrorKind } from '@/lib/request-errors';
import { HttpError } from '@/services/http';

/**
 * Returns a function that maps a failed request to a readable message.
 *
 * @param byCode - Messages for specific API error codes, checked first.
 * @returns `(err, fallback?) => message`; `fallback` replaces the generic and
 *   server-fault wording with the screen's own (e.g. "Couldn't save the link").
 */
export function useRequestErrorMessage(
  byCode: Readonly<Record<string, string>> = {},
): (err: unknown, fallback?: string) => string {
  const t = useTranslations('form.request_error');
  const tForm = useTranslations('form');
  return (err: unknown, fallback?: string) => {
    const code = requestErrorCode(err);
    const own = code && Object.hasOwn(byCode, code) ? byCode[code] : undefined;
    if (own) return own;
    const kind = requestErrorKind(err);
    const text = fallback && (kind === 'generic' || kind === 'server') ? fallback : t(kind);
    // A server fault names its request, so support can find it.
    const id = kind === 'server' && err instanceof HttpError ? err.requestId : undefined;
    return id ? `${text} ${tForm('request_reference', { id })}` : text;
  };
}
