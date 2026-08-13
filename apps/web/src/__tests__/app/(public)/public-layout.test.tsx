/**
 * Test: `(public)/layout.tsx` — the light-theme wrapper shared by
 * `/login` and `/register`.
 *
 * Asserts the `bd-public-light` theme class is applied, children render, and
 * the language switcher slot is present.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/shell/LanguageSwitcher', () => ({
  LanguageSwitcher: () => <div data-testid="lang-switcher" />,
}));

import PublicAuthLayout from '@/app/(public)/layout';

describe('<PublicAuthLayout />', () => {
  it('wraps children in the bd-public-light theme class', () => {
    const { container } = render(
      <PublicAuthLayout>
        <div data-testid="child">hello</div>
      </PublicAuthLayout>,
    );
    expect(container.querySelector('.bd-public-light')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toHaveTextContent('hello');
  });

  it('renders the language switcher in the top-right slot', () => {
    render(
      <PublicAuthLayout>
        <div />
      </PublicAuthLayout>,
    );
    expect(screen.getByTestId('lang-switcher')).toBeInTheDocument();
  });
});
