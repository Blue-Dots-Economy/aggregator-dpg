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

import { WaitingToVerify } from '@/components/console/WaitingToVerify';
import { WAITING_TO_VERIFY_ID } from '@/lib/waiting-to-verify';

const row = (id: string, name: string, detail?: string) => ({
  id,
  name,
  detail,
  href: `/console/x/${id}`,
  registeredAt: '2026-11-13T06:00:00.000Z',
});

describe('WaitingToVerify', () => {
  it('renders nothing when nobody is waiting', async () => {
    expect(await WaitingToVerify({ rows: [] })).toBeNull();
  });

  it('lists each registration with its link, detail, status and date under the scroll anchor', async () => {
    const { container } = render(
      await WaitingToVerify({ rows: [row('c1', 'Org22'), row('u1', 'Meena', 'meena@x.org')] }),
    );

    expect(container.querySelector(`#${WAITING_TO_VERIFY_ID}`)).not.toBeNull();
    expect(screen.getByRole('heading')).toHaveTextContent(
      'console.waiting_to_verify.heading:{"count":2}',
    );
    expect(screen.getByRole('link', { name: 'Org22' })).toHaveAttribute('href', '/console/x/c1');
    expect(screen.getByText('meena@x.org')).toBeInTheDocument();
    expect(screen.getAllByText('console.waiting_to_verify.status')).toHaveLength(2);
    expect(screen.getAllByText(/console\.waiting_to_verify\.registered: 13 Nov 2026/)).toHaveLength(
      2,
    );
  });
});
