/**
 * Unit tests for ActingBanner: shown only while an org owner acts as their own
 * coordinator account, names the organisation, and can be dismissed.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { AuthProvider } from '@/lib/auth-context';
import { ActingBanner } from '@/components/shell/ActingBanner';

function renderBanner(acting: { orgName: string | null } | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AuthProvider initialUser={null} acting={acting}>
        <ActingBanner />
      </AuthProvider>
    </NextIntlClientProvider>,
  );
}

describe('<ActingBanner />', () => {
  it('names the organisation while acting', () => {
    renderBanner({ orgName: 'Acme Jobs' });
    expect(
      screen.getByText(
        "You're onboarding as yourself in Acme Jobs. Counts here are only your own.",
      ),
    ).toBeInTheDocument();
  });

  it('leaves the organisation out when it is not known', () => {
    renderBanner({ orgName: null });
    expect(
      screen.getByText("You're onboarding as yourself. Counts here are only your own."),
    ).toBeInTheDocument();
  });

  it('is a plain region, not a live status', () => {
    renderBanner({ orgName: 'Acme Jobs' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('hides once dismissed', () => {
    renderBanner({ orgName: 'Acme Jobs' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/onboarding as yourself/)).toBeNull();
  });

  it('renders nothing when not acting', () => {
    const { container } = renderBanner(null);
    expect(container).toBeEmptyDOMElement();
  });
});
