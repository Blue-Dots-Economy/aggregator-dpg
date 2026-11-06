'use client';

/**
 * Turns a failed request into one translated sentence (`@aggregator-dpg/web`).
 *
 * @module apps/web/src/components/forms/useRequestErrorMessage
 */

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { requestErrorCode, requestErrorKind } from '../../lib/request-errors';

/**
 * Returns a function that maps a failed request to a readable message.
 *
 * @param byCode - Messages for specific API error codes, checked first.
 * @returns `(err) => message`.
 */
export function useRequestErrorMessage(
  byCode: Readonly<Record<string, string>> = {},
): (err: unknown) => string {
  const t = useTranslations('form.request_error');
  return useCallback(
    (err: unknown) => {
      const code = requestErrorCode(err);
      if (code && byCode[code]) return byCode[code];
      return t(requestErrorKind(err));
    },
    // byCode is usually an inline literal, so its contents are the dependency.
    [t, JSON.stringify(byCode)],
  );
}
