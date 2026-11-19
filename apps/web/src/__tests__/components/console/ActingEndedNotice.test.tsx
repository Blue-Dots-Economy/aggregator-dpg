/**
 * Unit tests for ActingEndedNotice: the console notice after acting mode ended.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';

const search = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search.value),
}));

import { ActingEndedNotice } from '@/components/console/ActingEndedNotice';

function renderNotice(query: string) {
  search.value = query;
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ActingEndedNotice />
    </NextIntlClientProvider>,
  );
}

describe('<ActingEndedNotice />', () => {
  it('shows the notice for reason=acting_ended', () => {
    renderNotice('reason=acting_ended');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your onboarding access is no longer available.',
    );
  });

  it.each(['', 'reason=other'])('shows nothing for "%s"', (query) => {
    const { container } = renderNotice(query);
    expect(container).toBeEmptyDOMElement();
  });
});
