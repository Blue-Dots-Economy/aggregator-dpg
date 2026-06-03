import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { StatusPill } from '../../components/ui/StatusPill';
import type { ComponentProps } from 'react';

const messages = {
  status_pill: {
    active: 'Active',
    at_risk: 'At Risk',
    inactive: 'Inactive',
    satisfied: 'Satisfied',
    complete: 'Complete',
    incomplete: 'Incomplete',
  },
};

function renderPill(status: ComponentProps<typeof StatusPill>['status']) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StatusPill status={status} />
    </NextIntlClientProvider>,
  );
}

describe('<StatusPill />', () => {
  it('renders the active label', () => {
    renderPill('active');
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders an at-risk label', () => {
    renderPill('at-risk');
    expect(screen.getByText('At Risk')).toBeInTheDocument();
  });

  it('renders complete and incomplete labels', () => {
    renderPill('complete');
    expect(screen.getByText('Complete')).toBeInTheDocument();
    renderPill('incomplete');
    expect(screen.getByText('Incomplete')).toBeInTheDocument();
  });
});
