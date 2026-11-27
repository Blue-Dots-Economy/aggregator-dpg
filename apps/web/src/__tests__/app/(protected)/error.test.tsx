/**
 * The coordinator portal's error screen: plain words, a retry and a way back,
 * never the framework's error text.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import ProtectedError from '@/app/(protected)/error';

function renderError(error: Error, reset: () => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProtectedError error={error} reset={reset} />
    </NextIntlClientProvider>,
  );
}

describe('protected error screen', () => {
  it('explains a failed page and retries', () => {
    const reset = vi.fn();
    renderError(new Error('boom'), reset);
    expect(screen.getByRole('heading', { name: messages.page_error.title })).toBeInTheDocument();
    expect(screen.getByText(messages.page_error.body)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: messages.page_error.retry }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('links back to the dashboard', () => {
    renderError(new Error('boom'), vi.fn());
    expect(screen.getByRole('link', { name: messages.page_error.home })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('never shows the error message or digest', () => {
    const error = Object.assign(new Error('upstream 500: token abc123'), { digest: 'd-42' });
    renderError(error, vi.fn());
    expect(screen.queryByText(/abc123/)).toBeNull();
    expect(screen.queryByText(/d-42/)).toBeNull();
  });
});
