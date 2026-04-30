import { describe, it, expect } from 'vitest';
import { renderAdminReview } from './admin-review.js';
import { renderApplicantApproved } from './applicant-approved.js';
import { renderApplicantRejected } from './applicant-rejected.js';

describe('admin-review template', () => {
  it('renders applicant fields and action links', () => {
    const out = renderAdminReview({
      registrationId: 'reg-1',
      applicantName: 'Asha Rao',
      applicantEmail: 'asha@trrain.org',
      applicantPhone: '+919876543210',
      association: 'TRRAIN',
      aggregatorType: 'seeker',
      state: 'Karnataka',
      about: 'Skilling NGO based in Hubli',
      approveUrl: 'http://localhost:4000/admin/v1/.../approve?token=A',
      rejectUrl: 'http://localhost:4000/admin/v1/.../reject?token=R',
      submittedAt: new Date('2026-04-30T10:00:00Z'),
    });
    expect(out.subject).toContain('TRRAIN');
    expect(out.html).toContain('Asha Rao');
    expect(out.html).toContain('asha@trrain.org');
    expect(out.html).toContain('Karnataka');
    expect(out.html).toContain('approve?token=A');
    expect(out.html).toContain('reject?token=R');
    expect(out.text).toContain('asha@trrain.org');
  });

  it('escapes user-controlled fields', () => {
    const out = renderAdminReview({
      registrationId: 'reg-1',
      applicantName: '<script>alert(1)</script>',
      applicantEmail: 'a@b.in',
      applicantPhone: '+919876543210',
      association: 'X & Y',
      aggregatorType: 'provider',
      approveUrl: 'http://x',
      rejectUrl: 'http://y',
      submittedAt: new Date(),
    });
    expect(out.html).not.toContain('<script>alert');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('X &amp; Y');
  });
});

describe('applicant-approved template', () => {
  it('greets the contact and links to sign in', () => {
    const out = renderApplicantApproved({
      contactName: 'Asha',
      association: 'TRRAIN',
      identifier: 'asha@trrain.org',
      signInUrl: 'http://localhost:3000/login',
    });
    expect(out.subject).toBe('Your Blue Dots aggregator account is approved');
    expect(out.html).toContain('Asha');
    expect(out.html).toContain('TRRAIN');
    expect(out.html).toContain('asha@trrain.org');
    expect(out.html).toContain('http://localhost:3000/login');
  });
});

describe('applicant-rejected template', () => {
  it('renders without a reason', () => {
    const out = renderApplicantRejected({
      contactName: 'Asha',
      association: 'TRRAIN',
    });
    expect(out.subject).toContain('Update');
    expect(out.html).toContain('Asha');
    expect(out.html).toContain('TRRAIN');
    expect(out.html).not.toContain('Reason:');
  });

  it('renders with a reason', () => {
    const out = renderApplicantRejected({
      contactName: 'Asha',
      association: 'TRRAIN',
      reason: 'Insufficient documentation',
    });
    expect(out.html).toContain('Insufficient documentation');
    expect(out.text).toContain('Insufficient documentation');
  });
});
