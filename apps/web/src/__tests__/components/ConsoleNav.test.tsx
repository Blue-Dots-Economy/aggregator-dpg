import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('next/navigation', () => ({ usePathname: () => '/console' }));

import { ConsoleNav } from '@/components/console/ConsoleNav';

describe('<ConsoleNav />', () => {
  it('shows coordinators and invite by default', () => {
    render(<ConsoleNav isNetworkAdmin={false} />);
    expect(screen.getByText('nav.coordinators')).toBeInTheDocument();
    expect(screen.getByText('nav.invite')).toBeInTheDocument();
    expect(screen.queryByText('nav.organisations')).not.toBeInTheDocument();
  });

  it('hides coordinators and invite without org.manage (RBAC)', () => {
    render(<ConsoleNav isNetworkAdmin canManage={false} />);
    expect(screen.queryByText('nav.coordinators')).not.toBeInTheDocument();
    expect(screen.queryByText('nav.invite')).not.toBeInTheDocument();
    expect(screen.getByText('nav.organisations')).toBeInTheDocument();
  });
});
