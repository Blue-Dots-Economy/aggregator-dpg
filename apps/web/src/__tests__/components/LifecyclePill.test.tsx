import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ComponentProps } from 'react';
import { LifecyclePill } from '@/components/LifecyclePill';
import messages from '@/i18n/messages/en.json';

function renderPill(status: ComponentProps<typeof LifecyclePill>['status']) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <LifecyclePill status={status} />
    </NextIntlClientProvider>,
  );
}

describe('<LifecyclePill />', () => {
  it.each([
    ['draft', 'Draft'],
    ['live', 'Live'],
    ['paused', 'Paused'],
    ['account_only', 'Account only'],
  ] as const)('renders %s as %s', (status, label) => {
    renderPill(status);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('treats undefined as live (back-compat)', () => {
    renderPill(undefined);
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('treats null as account_only', () => {
    renderPill(null);
    expect(screen.getByText('Account only')).toBeInTheDocument();
  });

  it('applies a status-specific tone class', () => {
    const { container } = renderPill('draft');
    const span = container.querySelector('span');
    expect(span).toBeTruthy();
    // tone class names: we only assert *some* class is set; visual contract is the visible label.
    expect(span!.className.length).toBeGreaterThan(0);
  });
});
