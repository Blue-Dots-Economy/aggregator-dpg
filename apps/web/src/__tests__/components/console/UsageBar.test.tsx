import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageBar } from '@/components/console/UsageBar';

describe('<UsageBar />', () => {
  it('is a named progress bar with the used count and the limit', () => {
    render(<UsageBar label="Organisations used" value={7} max={50} />);
    const bar = screen.getByRole('progressbar', { name: 'Organisations used' });
    expect(bar.tagName).toBe('PROGRESS');
    expect(bar).toHaveAttribute('value', '7');
    expect(bar).toHaveAttribute('max', '50');
  });

  it('turns amber from 80% of the limit', () => {
    const { rerender } = render(<UsageBar label="Used" value={39} max={50} />);
    expect(screen.getByRole('progressbar').className).not.toContain('amber');
    rerender(<UsageBar label="Used" value={40} max={50} />);
    expect(screen.getByRole('progressbar').className).toContain('amber');
  });

  it('caps the value at the limit and handles a zero limit', () => {
    const { rerender } = render(<UsageBar label="Used" value={60} max={50} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '50');
    rerender(<UsageBar label="Used" value={3} max={0} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('value', '0');
    expect(bar).toHaveAttribute('max', '1');
  });
});
