import { describe, it, expect } from 'vitest';
import { renderAdminReview } from './admin-review.js';
import { renderApplicantApproved } from './applicant-approved.js';
import { renderApplicantRejected } from './applicant-rejected.js';
import { renderCoordinatorInvite } from './coordinator-invite.js';
import { renderOwnerGrantRefreshed } from './owner-grant-refreshed.js';
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

  it('highlights when the coordinator registered with a different email than invited (#701)', () => {
    const base = {
      registrationId: 'reg-1',
      applicantName: 'Asha',
      applicantEmail: 'my-own@x.org',
      applicantPhone: '+919876543210',
      association: 'JFC',
      approveUrl: 'http://x',
      rejectUrl: 'http://y',
      submittedAt: new Date('2026-04-30T10:00:00Z'),
      expiresInText: '7 days',
    };
    const differ = renderAdminReview({ ...base, invitedEmail: 'invited@x.org' });
    expect(differ.html).toContain('Invited email');
    expect(differ.html).toContain('invited@x.org');
    expect(differ.text).toContain('invited@x.org');
    // When invited == registered (or omitted), no highlight.
    const same = renderAdminReview({ ...base, invitedEmail: 'my-own@x.org' });
    expect(same.html).not.toContain('Invited email');
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

describe('coordinator-invite template', () => {
  it('names the org + inviter, the role, the link, and an absolute expiry', () => {
    const out = renderCoordinatorInvite({
      orgName: 'Joint Facilitation Centre',
      inviterEmail: 'owner@jfc.org',
      inviteUrl: 'https://portal.example.org/register/coordinator?invite=abc',
      expiresOn: '15 Sep 2026',
      recipientName: 'Asha',
    });
    expect(out.subject).toContain('Joint Facilitation Centre');
    expect(out.html).toContain('Joint Facilitation Centre');
    // Sender identity — who invited them.
    expect(out.html).toContain('owner@jfc.org');
    // Role context + post-register expectation.
    expect(out.html).toContain('as a coordinator');
    expect(out.html).toContain('reviews your request');
    // Absolute expiry, not a relative "in N days".
    expect(out.html).toContain('15 Sep 2026');
    expect(out.html).toContain('Hi Asha,');
    expect(out.text).toContain('https://portal.example.org/register/coordinator?invite=abc');
    expect(out.text).toContain('owner@jfc.org');
  });

  it('falls back to a generic greeting without a name, and escapes fields', () => {
    const out = renderCoordinatorInvite({
      orgName: '<b>Org</b> & Co',
      inviterEmail: 'o@x.in',
      inviteUrl: 'https://x/invite',
      expiresOn: '15 Sep 2026',
    });
    expect(out.html).toContain('Hello,');
    expect(out.html).not.toContain('<b>Org</b>');
    expect(out.html).toContain('&lt;b&gt;Org&lt;/b&gt; &amp; Co');
  });
});

describe('owner-grant-refreshed template', () => {
  it('reads as a fresh link (not a duplicate approval), no sign-in', () => {
    const out = renderOwnerGrantRefreshed({
      orgName: 'Acme Org',
      inviteUrl: 'https://portal.example.org/register/invite?grant=xyz',
    });
    expect(out.subject).toContain('new invite link');
    expect(out.subject).toContain('Acme Org');
    expect(out.html).toContain('previous link had expired');
    expect(out.html).toContain('https://portal.example.org/register/invite?grant=xyz');
    expect(out.html).not.toContain('is approved');
    expect(out.html).not.toContain('Sign in');
  });
});
