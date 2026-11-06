import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PageError } from '@/components/ui/PageError';

const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

const COPY = { title: 'Title', body: 'Body', retry: 'Retry' };
const HOME = { href: '/somewhere', label: 'Home' };

describe('PageError', () => {
  it('renders the copy and links home', () => {
    render(<PageError copy={COPY} home={HOME} reset={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/somewhere');
  });

  it('retries against the server: refreshes the route and resets the boundary', () => {
    refresh.mockClear();
    const reset = vi.fn();
    render(<PageError copy={COPY} home={HOME} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('leaves out the home link when there is no home to go to', () => {
    render(<PageError copy={COPY} reset={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
