import { describe, it, expect } from 'vitest';
import { renderApplicantApproved } from './applicant-approved.js';
import { renderApplicantRejected } from './applicant-rejected.js';
import { renderCoordinatorInvite } from './coordinator-invite.js';
import { renderOrgOwnerApproved } from './org-owner-approved.js';
import { renderOrgKnownAs } from './org-known-as.js';

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

  it('names a coordinator application plainly, with no reply-to-this-email line', () => {
    const out = renderApplicantRejected({
      contactName: 'Asha',
      association: 'TRRAIN',
      entityLabel: 'coordinator',
    });
    expect(out.subject).toContain('coordinator application');
    expect(out.text).toContain('coordinator application for TRRAIN');
    expect(out.text).not.toContain('onboard');
    expect(out.text).not.toContain('reply to this email');
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
    expect(out.html).not.toContain('Sign in to manage your organisation');
    expect(out.html).toContain('follow-up');
    expect(out.text).toContain('follow-up');
  });

  it('renders the sign-in CTA when a link is provided (Phase 5)', () => {
    const out = renderOrgOwnerApproved({
      orgName: 'Acme Org',
      ownerEmail: 'a@acme.org',
      inviteUrl: 'https://portal.example.org/login',
    });
    expect(out.html).toContain('Sign in to manage your organisation');
    expect(out.html).toContain('https://portal.example.org/login');
    expect(out.text).toContain('https://portal.example.org/login');
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
    expect(out.html).toContain('as a user');
    expect(out.html).toContain('no further approval is needed');
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

describe('org-known-as template', () => {
  it('names the parent org and the org, and links the console; no value is named', () => {
    const out = renderOrgKnownAs({
      orgName: 'Beta Org',
      parentName: 'Alpha Org',
      consoleUrl: 'https://portal.example.org/console',
    });
    expect(out.subject).toContain('a change to Beta Org');
    expect(out.html).toContain(
      'The owner of <strong>Alpha Org</strong> changed what <strong>Beta Org</strong> is known as.',
    );
    expect(out.html).not.toContain('network administrator');
    expect(out.html).toContain('https://portal.example.org/console');
    expect(out.text).toContain('The owner of Alpha Org changed what Beta Org is known as.');
  });

  it('escapes the org names in the HTML part', () => {
    const out = renderOrgKnownAs({
      orgName: '<b>Beta</b>',
      parentName: 'A & B',
      consoleUrl: 'https://portal.example.org/console',
    });
    expect(out.html).not.toContain('<b>Beta</b>');
    expect(out.html).toContain('A &amp; B');
  });
});
