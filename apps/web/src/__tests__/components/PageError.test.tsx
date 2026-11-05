import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PageError } from '@/components/ui/PageError';

const COPY = { title: 'Title', body: 'Body', retry: 'Retry', home: 'Home' };

describe('PageError', () => {
  it('renders the copy, retries and links home', () => {
    const reset = vi.fn();
    render(<PageError copy={COPY} homeHref="/somewhere" reset={reset} />);
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('Body')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/somewhere');
  });
});
