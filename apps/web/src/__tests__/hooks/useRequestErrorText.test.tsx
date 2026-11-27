import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { HttpError } from '@/services/http';
import { isDomainNotServed, useRequestErrorText } from '@/hooks/useRequestErrorText';

const wrapper = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={messages}>
    {children}
  </NextIntlClientProvider>
);

describe('isDomainNotServed', () => {
  it('is true only for an HttpError with DOMAIN_NOT_SERVED', () => {
    expect(isDomainNotServed(new HttpError(403, 'DOMAIN_NOT_SERVED'))).toBe(true);
    expect(isDomainNotServed(new HttpError(403, 'FORBIDDEN'))).toBe(false);
    expect(isDomainNotServed(new HttpError(500, undefined))).toBe(false);
    expect(isDomainNotServed(new Error('DOMAIN_NOT_SERVED'))).toBe(false);
  });
});

describe('useRequestErrorText', () => {
  it('gives the profile-type message for DOMAIN_NOT_SERVED and the fallback otherwise', () => {
    const { result } = renderHook(() => useRequestErrorText(), { wrapper });
    expect(result.current(new HttpError(403, 'DOMAIN_NOT_SERVED'), 'fallback')).toBe(
      messages.access.domain_not_served,
    );
    expect(result.current(new Error('raw body'), 'fallback')).toBe('fallback');
  });
});
