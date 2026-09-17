/**
 * `components/login/BrandAttribution` — the "Owned by / Managed by" rows on the
 * login page's right pane (signals-dpg#720).
 *
 * The behaviour worth pinning is the opt-in: this renders nothing at all unless
 * a brand declares `attribution`, which is every brand but alimco. A regression
 * that rendered an empty wrapper would put a stray gap on every other
 * deployment's login page.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BrandAttribution } from '@/components/login/BrandAttribution';

describe('BrandAttribution', () => {
  it('renders nothing when the brand declares no attribution', () => {
    const { container } = render(<BrandAttribution rows={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an empty array, not an empty wrapper', () => {
    const { container } = render(<BrandAttribution rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders each row as its mark alone, with the org name as the accessible name', () => {
    render(
      <BrandAttribution
        rows={[
          { label: 'Owned by', name: 'Swavlamban', logo: '/brand/alimco/swavlamban-mark.png' },
          { label: 'Managed by', name: 'ALIMCO', logo: '/brand/alimco/alimco-mark.png' },
        ]}
      />,
    );

    expect(screen.getByText('Owned by')).toBeInTheDocument();
    expect(screen.getByText('Managed by')).toBeInTheDocument();

    // The name is the image's alt text, NOT visible copy beside the mark —
    // "only logo is enough, not text" was the explicit ask.
    expect(screen.getByAltText('Swavlamban')).toBeInTheDocument();
    expect(screen.getByAltText('ALIMCO')).toBeInTheDocument();
    expect(screen.queryByText('Swavlamban')).not.toBeInTheDocument();
    expect(screen.queryByText('ALIMCO')).not.toBeInTheDocument();
  });

  it('falls back to the name as text when a row ships no logo', () => {
    render(<BrandAttribution rows={[{ label: 'Owned by', name: 'Swavlamban' }]} />);

    expect(screen.getByText('Swavlamban')).toBeInTheDocument();
    expect(screen.queryByAltText('Swavlamban')).not.toBeInTheDocument();
  });
});
