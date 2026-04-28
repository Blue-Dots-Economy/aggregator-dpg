import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusPill } from '../../components/ui/StatusPill';

describe('<StatusPill />', () => {
  it('renders the active label', () => {
    render(<StatusPill status="active" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders an at-risk label', () => {
    render(<StatusPill status="at-risk" />);
    expect(screen.getByText('At Risk')).toBeInTheDocument();
  });

  it('renders complete and incomplete labels', () => {
    const { rerender } = render(<StatusPill status="complete" />);
    expect(screen.getByText('Complete')).toBeInTheDocument();
    rerender(<StatusPill status="incomplete" />);
    expect(screen.getByText('Incomplete')).toBeInTheDocument();
  });
});
