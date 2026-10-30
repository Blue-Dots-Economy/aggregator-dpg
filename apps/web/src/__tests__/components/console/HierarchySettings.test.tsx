/**
 * Unit tests for HierarchySettings (read-only tree limits and "known as" values).
 *
 * Covers: the limits, "no limit" for unset max_children, the org total
 * against its maximum, and each value with its depths and org count.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { OrgHierarchyResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { HierarchySettings } from '@/components/console/HierarchySettings';

const hierarchy: OrgHierarchyResponse = {
  network: { id: 'root', name: 'Blue Dots Network' },
  limits: { max_depth: 3, max_children: null, max_total_orgs: 50 },
  total_orgs: 7,
  known_as: {
    values: [
      { key: 'aggregator', name: 'Aggregator', depths: null, system: true, org_count: 4 },
      { key: 'state', name: 'State', depths: [1], system: false, org_count: 1 },
      { key: 'district', name: 'District', depths: [1, 2], system: false, org_count: 2 },
    ],
    suggest: [{ depth: 1, key: 'state' }],
  },
};

function renderIt(h: OrgHierarchyResponse = hierarchy) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HierarchySettings hierarchy={h} />
    </NextIntlClientProvider>,
  );
}

const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('<HierarchySettings />', () => {
  it('shows the limits and the org total', () => {
    renderIt();
    expect(screen.getByText(messages.console.orgs.max_depth)).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(messages.console.orgs.no_limit)).toBeInTheDocument();
    expect(screen.getByText('7 of 50')).toBeInTheDocument();
  });

  it('shows the child limit when set', () => {
    renderIt({ ...hierarchy, limits: { ...hierarchy.limits, max_children: 12 } });
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.queryByText(messages.console.orgs.no_limit)).toBeNull();
  });

  it('lists each value with its depths and org count', () => {
    renderIt();
    expect(row('Aggregator')).toHaveTextContent('any depth');
    expect(row('Aggregator')).toHaveTextContent(messages.console.orgs.system_value);
    expect(row('Aggregator')).toHaveTextContent('4 organisations');
    expect(row('State')).toHaveTextContent('depth 1');
    expect(row('State')).toHaveTextContent('1 organisation');
    expect(row('District')).toHaveTextContent('depths 1, 2');
  });

  it('shows how much of the organisation limit is used', () => {
    renderIt();
    const bar = screen.getByRole('progressbar', { name: messages.console.orgs.total_orgs });
    expect(bar).toHaveAttribute('aria-valuenow', '7');
    expect(bar).toHaveAttribute('aria-valuemax', '50');
  });

  it('offers no edit actions', () => {
    renderIt();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
