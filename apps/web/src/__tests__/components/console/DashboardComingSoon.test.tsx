import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { DashboardComingSoon } from '@/components/console/DashboardComingSoon';

describe('<DashboardComingSoon />', () => {
  it('shows the aggregated view first and switches to the seeker and provider view', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <DashboardComingSoon />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('tab', { name: 'Aggregated View' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Your dashboard is coming soon.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Seeker & Provider View' }));
    expect(
      screen.getByText('This works only if you have onboarded seekers and providers yourself.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });
});
