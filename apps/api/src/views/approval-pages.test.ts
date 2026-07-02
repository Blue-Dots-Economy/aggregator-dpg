import { describe, it, expect } from 'vitest';
import { renderResultPage } from './approval-pages.js';

describe('renderResultPage action button', () => {
  it('omits the resend form when no action is given', () => {
    const html = renderResultPage({ status: 'error', title: 'Invalid link', message: 'x' });
    expect(html).not.toContain('name="token"');
  });

  it('renders a resend form POSTing the token when action is given', () => {
    const html = renderResultPage({
      status: 'error',
      title: 'Link expired',
      message: 'x',
      action: {
        url: 'https://api.local/admin/v1/aggregator-registrations/resend/agg-1',
        token: 'tok-123',
        label: 'Resend approval link',
      },
    });
    expect(html).toContain(
      'action="https://api.local/admin/v1/aggregator-registrations/resend/agg-1"',
    );
    expect(html).toContain('value="tok-123"');
    expect(html).toContain('Resend approval link');
  });
});
