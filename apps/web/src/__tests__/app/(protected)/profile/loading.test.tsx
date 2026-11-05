/**
 * The profile page reads the registration schema on the server, so the
 * segment shows a loading status while it renders.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import ProfileLoading from '@/app/(protected)/profile/loading';

describe('profile loading screen', () => {
  it('shows the loading status', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ProfileLoading />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(messages.common.loading);
  });
});
