/**
 * Unit tests for `useIsClient`.
 *
 * Covers: `false` in a server render, `true` in a browser render.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { useIsClient } from '@/hooks/useIsClient';

function Probe() {
  return <span data-testid="probe">{useIsClient() ? 'client' : 'server'}</span>;
}

describe('useIsClient', () => {
  it('is false in a server render', () => {
    expect(renderToString(<Probe />)).toContain('server');
  });

  it('is true in a browser render', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('client');
  });
});
