import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(
    async () => (key: string, values?: Record<string, unknown>) =>
      values ? `console.${key}:${JSON.stringify(values)}` : `console.${key}`,
  ),
  getFormatter: vi.fn(async () => ({ dateTime: () => '13 Nov 2026' })),
}));
vi.mock('@/components/console/ConsoleUi', () => ({
  ConsoleSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

import { RegisteredOrgs } from '@/components/console/RegisteredOrgs';

const org = (id: string, name: string) =>
  ({ id, name, status: 'pending', created_at: '2026-11-13T06:00:00.000Z' }) as never;

describe('RegisteredOrgs', () => {
  it('renders nothing when no organisation is waiting', async () => {
    expect(await RegisteredOrgs({ orgs: [] })).toBeNull();
  });

  it('lists each waiting organisation with a link, its status and when it registered', async () => {
    render(await RegisteredOrgs({ orgs: [org('c1', 'Org22'), org('c2', 'Org23')] }));

    expect(screen.getByRole('heading')).toHaveTextContent(
      'console.registered_orgs.heading:{"count":2}',
    );
    expect(screen.getByRole('link', { name: 'Org22' })).toHaveAttribute('href', '/console/orgs/c1');
    expect(screen.getAllByText('console.registered_orgs.status')).toHaveLength(2);
    expect(screen.getAllByText(/console\.registered_orgs\.registered: 13 Nov 2026/)).toHaveLength(
      2,
    );
  });
});
