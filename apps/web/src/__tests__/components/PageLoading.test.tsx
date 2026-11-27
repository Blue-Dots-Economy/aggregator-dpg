import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { PageLoading } from '@/components/ui/PageLoading';

describe('PageLoading', () => {
  it('announces the translated loading text as a status', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <PageLoading />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(messages.common.loading);
  });
});
