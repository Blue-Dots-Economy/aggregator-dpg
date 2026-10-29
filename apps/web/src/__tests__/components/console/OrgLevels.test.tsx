/**
 * Unit tests for OrgLevels (read-only levels strip).
 *
 * Covers: the network at Level 0, each level with its values and their
 * counts, the level total (plural and none), and no edit actions.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { OrgHierarchyResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { OrgLevels } from '@/components/console/OrgLevels';

const hierarchy: OrgHierarchyResponse = {
  network: { id: 'root', name: 'Blue Dots Network' },
  levels: [
    { level: 1, values: [{ key: 'state', label: 'State', org_count: 1 }] },
    {
      level: 2,
      values: [
        { key: 'district', label: 'District', org_count: 5 },
        { key: 'block', label: 'Block', org_count: 1 },
      ],
    },
    { level: 3, values: [{ key: 'aggregator', label: 'Aggregator', org_count: 0 }] },
  ],
};

function renderLevels() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgLevels hierarchy={hierarchy} />
    </NextIntlClientProvider>,
  );
}

const card = (heading: string) => screen.getByText(heading).closest('li') as HTMLElement;

describe('<OrgLevels />', () => {
  it('starts with the network at Level 0', () => {
    renderLevels();
    expect(card('Level 0')).toHaveTextContent('Blue Dots Network');
    expect(card('Level 0')).toHaveTextContent(messages.console.orgs.network_tag);
  });

  it('shows each level with its values, their counts and the total', () => {
    renderLevels();
    expect(card('Level 1')).toHaveTextContent('State1');
    expect(card('Level 1')).toHaveTextContent('1 organisation');
    expect(card('Level 2')).toHaveTextContent('District5');
    expect(card('Level 2')).toHaveTextContent('Block1');
    expect(card('Level 2')).toHaveTextContent('6 organisations');
    expect(card('Level 3')).toHaveTextContent('No organisations');
  });

  it('offers no edit actions', () => {
    renderLevels();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(messages.console.orgs.levels_hint)).toBeInTheDocument();
  });
});
