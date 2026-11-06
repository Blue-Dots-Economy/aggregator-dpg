/**
 * The error screen above the console layout. It shows when the layout itself
 * fails, for example when the API is down, so it offers a retry only: every
 * console link goes through the same layout.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import ConsoleLayoutError from '@/app/(console)/error';

const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

function renderError(error: Error, reset: () => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ConsoleLayoutError error={error} reset={reset} />
    </NextIntlClientProvider>,
  );
}

describe('console layout error screen', () => {
  it('explains that the console could not load and retries against the server', () => {
    const reset = vi.fn();
    renderError(new Error('console unavailable'), reset);
    expect(
      screen.getByRole('heading', { name: messages.console.unavailable.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(messages.console.unavailable.body)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: messages.console.unavailable.retry }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('offers no link back into the console', () => {
    renderError(new Error('console unavailable'), vi.fn());
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('never shows the error message or digest', () => {
    const error = Object.assign(new Error('upstream 503: token abc123'), { digest: 'd-42' });
    renderError(error, vi.fn());
    expect(screen.queryByText(/abc123/)).toBeNull();
    expect(screen.queryByText(/d-42/)).toBeNull();
  });
});
