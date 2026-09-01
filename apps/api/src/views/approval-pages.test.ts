import { describe, it, expect } from 'vitest';
import { renderResultPage, renderConfirmPage, setApprovalBrand } from './approval-pages.js';

describe('setApprovalBrand', () => {
  it('seeds the runtime brand used by render functions that omit an explicit override', () => {
    setApprovalBrand({
      short_name: 'Test Network',
      long_name: 'Test Network Portal',
      primary_color: '#123456',
      portal_url: 'https://test.invalid',
    });
    const html = renderConfirmPage({
      aggregatorId: 'agg-1',
      token: 'tok',
      applicantEmail: 'a@b.com',
      association: 'Acme',
      aggregatorType: 'seeker',
      postUrl: 'https://api.local/decision/agg-1',
      expiresInText: '1 hour',
    });
    expect(html).toContain('Test Network');
    // One link, both actions: the review page carries Approve + Reject.
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="reject"');
    // Restore the default runtime brand so later tests in the suite (which
    // rely on DEFAULT_BRAND when no override is passed) are unaffected.
    setApprovalBrand({
      short_name: 'Aggregator',
      long_name: 'Aggregator Portal',
      primary_color: '#4f46e5',
      portal_url: 'http://localhost:3000',
    });
  });
});

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
