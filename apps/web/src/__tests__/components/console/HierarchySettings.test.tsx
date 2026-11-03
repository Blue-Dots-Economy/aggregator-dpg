/**
 * Unit tests for HierarchySettings (read-only tree limits and the editor for
 * the network's "known as" values).
 *
 * Covers: the limits, "no limit" for unset max_children, the org total
 * against its maximum, and the root's list in the editor.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { OrgHierarchyResponse } from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { HierarchySettings } from '@/components/console/HierarchySettings';

const hierarchy: OrgHierarchyResponse = {
  network: {
    id: '00000000-0000-4000-8000-0000000000a0',
    name: 'Blue Dots Network',
    child_known_as: [
      { key: 'state', name: 'State', default: true },
      { key: 'partner', name: 'Partner' },
    ],
  },
  limits: { max_depth: 3, max_children: null, max_total_orgs: 50 },
  total_orgs: 7,
};

function renderIt(h: OrgHierarchyResponse = hierarchy) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HierarchySettings hierarchy={h} />
    </NextIntlClientProvider>,
  );
}

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

  it('shows how much of the organisation limit is used', () => {
    renderIt();
    const bar = screen.getByRole('progressbar', { name: messages.console.orgs.total_orgs });
    expect(bar).toHaveAttribute('aria-valuenow', '7');
    expect(bar).toHaveAttribute('aria-valuemax', '50');
  });

  it("edits the network's list for top-level organisations", () => {
    renderIt();
    expect(screen.getByText(messages.console.orgs.top_level_known_as)).toBeInTheDocument();
    expect(screen.getByDisplayValue('State')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Partner')).toBeInTheDocument();
    const radios = screen.getAllByRole('radio', {
      name: messages.console.org.child_known_as_default,
    });
    expect(radios[0]).toBeChecked();
  });

  it('shows the empty state when the network has no values', () => {
    renderIt({ ...hierarchy, network: { ...hierarchy.network, child_known_as: [] } });
    expect(screen.getByText(messages.console.org.child_known_as_empty)).toBeInTheDocument();
  });
});
