/**
 * Unit test for the read-only organisation list.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => `console.${key}`),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => `console.${key}` }));

import { OrgsTable } from '@/components/console/OrgsTable';

type OrgRow = OrgSearchResponse['orgs'][number];

const row = (over: Partial<OrgRow> = {}): OrgRow =>
  ({
    id: 'o1',
    slug: 'alpha',
    name: 'Alpha',
    org_type: 'aggregator',
    status: 'pending',
    is_default: false,
    locations: [],
    legal_name: null,
    known_as: 'aggregator',
    known_as_name: 'Aggregator',
    depth: 1,
    parent_id: 'root',
    parent_name: 'The Network',
    description: null,
    profile: {},
    profile_ref: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    coordinator_count: 2,
    child_count: 0,
    pending_count: 1,
    ...over,
  }) as OrgRow;

describe('<OrgsTable />', () => {
  it('lists each organisation with a link to its page and no decision buttons', async () => {
    render(await OrgsTable({ orgs: [row(), row({ id: 'o2', name: 'Beta', status: 'active' })] }));
    expect(screen.getByRole('link', { name: 'Alpha' })).toHaveAttribute('href', '/console/orgs/o1');
    expect(screen.getByRole('link', { name: 'Beta' })).toHaveAttribute('href', '/console/orgs/o2');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says when there is nothing to list', async () => {
    render(await OrgsTable({ orgs: [] }));
    expect(screen.getByText('console.orgs.empty')).toBeInTheDocument();
  });
});
