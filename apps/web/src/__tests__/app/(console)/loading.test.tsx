/**
 * The console pages read on the server, so the segment shows a loading
 * status while they render.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import ConsoleLoading from '@/app/(console)/console/loading';

describe('console loading screen', () => {
  it('shows the loading status', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ConsoleLoading />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(messages.common.loading);
  });
});
