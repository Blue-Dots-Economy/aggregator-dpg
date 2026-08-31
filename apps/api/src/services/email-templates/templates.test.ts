import { describe, it, expect } from 'vitest';
import { renderAdminReview } from './admin-review.js';
import { renderApplicantApproved } from './applicant-approved.js';
import { renderApplicantRejected } from './applicant-rejected.js';
import { renderOrgOwnerApproved } from './org-owner-approved.js';

describe('admin-review template', () => {
  it('renders applicant fields and action links', () => {
    const out = renderAdminReview({
      registrationId: 'reg-1',
      applicantName: 'Asha Rao',
      applicantEmail: 'asha@trrain.org',
      applicantPhone: '+919876543210',
      association: 'TRRAIN',
      state: 'Karnataka',
      about: 'Skilling NGO based in Hubli',
      approveUrl: 'http://localhost:4000/admin/v1/.../approve?token=A',
      rejectUrl: 'http://localhost:4000/admin/v1/.../reject?token=R',
      submittedAt: new Date('2026-04-30T10:00:00Z'),
      expiresInText: '7 days',
    });
    expect(out.subject).toContain('TRRAIN');
    // Defaults to the aggregator (coordinator) wording.
    expect(out.subject).toContain('aggregator registration');
    expect(out.html).toContain('New aggregator registration');
    expect(out.html).toContain('Asha Rao');
    expect(out.html).toContain('asha@trrain.org');
    expect(out.html).toContain('Karnataka');
    expect(out.html).toContain('approve?token=A');
    expect(out.html).toContain('reject?token=R');
    expect(out.html).toContain('expires in 7 days');
    expect(out.text).toContain('asha@trrain.org');
  });

  it('escapes user-controlled fields', () => {
    const out = renderAdminReview({
      registrationId: 'reg-1',
      applicantName: '<script>alert(1)</script>',
      applicantEmail: 'a@b.in',
      applicantPhone: '+919876543210',
      association: 'X & Y',
      entityLabel: 'organisation',
      approveUrl: 'http://x',
      rejectUrl: 'http://y',
      submittedAt: new Date(),
      expiresInText: '7 days',
    });
    expect(out.html).not.toContain('<script>alert');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('X &amp; Y');
    // Org flow wording, not aggregator.
    expect(out.html).toContain('New organisation registration');
    expect(out.subject).toContain('organisation registration');
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
    // Subject uses the active brand short_name; default is "Aggregator"
    // when setEmailBrand hasn't been called in the test boot path.
    expect(out.subject).toMatch(/^Your .+ aggregator account is approved$/);
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

describe('org-owner-approved template', () => {
  it('renders the org name and owner email, with no sign-in CTA (#699)', () => {
    const out = renderOrgOwnerApproved({
      orgName: 'Joint Facilitation Centre',
      ownerEmail: 'owner@jfc.org',
    });
    expect(out.subject).toContain('Joint Facilitation Centre');
    expect(out.subject).toContain('approved');
    expect(out.html).toContain('Joint Facilitation Centre');
    expect(out.html).toContain('owner@jfc.org');
    expect(out.text).toContain('Joint Facilitation Centre');
    // Owner KC user stays disabled — the email must NOT invite sign-in.
    expect(out.html).not.toContain('Sign in');
    expect(out.html).not.toContain('/login');
  });

  it('omits the invite CTA when no invite link is provided (standalone ship)', () => {
    const out = renderOrgOwnerApproved({
      orgName: 'Acme Org',
      ownerEmail: 'a@acme.org',
    });
    expect(out.html).not.toContain('Invite your coordinators');
    expect(out.html).toContain('follow-up');
    expect(out.text).toContain('follow-up');
  });

  it('renders the invite CTA when an invite link is provided (#701)', () => {
    const out = renderOrgOwnerApproved({
      orgName: 'Acme Org',
      ownerEmail: 'a@acme.org',
      inviteUrl: 'https://portal.example.org/register/owner/invite?token=abc',
    });
    expect(out.html).toContain('Invite your coordinators');
    expect(out.html).toContain('https://portal.example.org/register/owner/invite?token=abc');
    expect(out.text).toContain('https://portal.example.org/register/owner/invite?token=abc');
  });

  it('escapes user-controlled fields', () => {
    const out = renderOrgOwnerApproved({
      orgName: '<script>alert(1)</script> & Co',
      ownerEmail: 'x@y.in',
    });
    expect(out.html).not.toContain('<script>alert');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('&amp; Co');
  });
});
