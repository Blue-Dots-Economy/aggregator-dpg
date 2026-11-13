import { describe, it, expect } from 'vitest';
import { renderCoordinatorInvite } from './coordinator-invite.js';
import { renderOrgKnownAs } from './org-known-as.js';

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
