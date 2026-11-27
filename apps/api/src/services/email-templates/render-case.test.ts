import { describe, it, expect, afterEach } from 'vitest';
import { renderCase } from './render-case.js';
import { _setEmailMessages } from './messages.js';

afterEach(() => {
  _setEmailMessages(null);
});

describe('renderCase — the one conversion', () => {
  it('renders subject, HTML and text from the same copy keys', () => {
    const out = renderCase('invite_existing_account', {
      orgName: 'Acme Org',
      signInUrl: 'https://portal.test/login',
    });
    expect(out.subject).toBe('You were invited to Acme Org');
    expect(out.html).toContain('Acme Org');
    expect(out.text).toContain('Acme Org');
    expect(out.text).not.toContain('<strong>');
  });

  it('emits a CTA as a button in HTML and as "Label: url" in text', () => {
    const out = renderCase('invite_existing_account', {
      orgName: 'Acme Org',
      signInUrl: 'https://portal.test/login',
    });
    expect(out.html).toContain('href="https://portal.test/login"');
    expect(out.text).toContain('Sign in: https://portal.test/login');
  });

  it('picks the first alternative whose conditions hold', () => {
    const invite = {
      orgName: 'Acme',
      inviterEmail: 'owner@acme.test',
      inviteUrl: 'https://portal.test/r?invite=t',
      expiresOn: '15 Sep 2026',
    };
    expect(renderCase('coordinator_invite', { ...invite, recipientName: 'Ravi' }).html).toContain(
      'Hi Ravi,',
    );
    expect(renderCase('coordinator_invite', invite).html).toContain('Hello,');
  });

  it('substitutes a derived token mid-sentence, already escaped', () => {
    const out = renderCase('coordinator_invite', {
      orgName: 'Acme',
      inviterEmail: 'owner@acme.test',
      inviteUrl: 'https://portal.test/r?invite=t',
      expiresOn: '15 Sep 2026',
      recipientName: "O'Brien",
    });
    // Escaped once, not twice: the greeting is an `html` token built from copy.
    expect(out.html).toContain('Hi O&#39;Brien,');
    expect(out.html).not.toContain('&amp;#39;');
  });

  it('escapes token values on substitution', () => {
    const out = renderCase('invite_existing_account', {
      orgName: '<script>alert(1)</script>',
      signInUrl: 'https://portal.test/i',
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('ends the text part with the brand sign-off', () => {
    const out = renderCase('invite_existing_account', {
      orgName: 'Acme',
      signInUrl: 'https://portal.test/login',
    });
    expect(out.text).toMatch(/\n\nSent by .+\.\n$/);
  });

  it('throws on an unregistered case rather than sending an empty email', () => {
    expect(() => renderCase('nope', {})).toThrow(/unknown email case/);
  });

  it('drops a CTA whose href token was not supplied', () => {
    // Guards against a button rendering with an empty href.
    const out = renderCase('invite_existing_account', { orgName: 'Acme' });
    expect(out.html).not.toContain('<a href=""');
  });

  it('escapes the CTA href — it never passes through substitute()', () => {
    // The registry declares signInUrl as `text`, but the CTA path bypasses
    // substitution entirely, so the escaping has to happen in the button
    // helper. An `&` in a query string must arrive as `&amp;`.
    const out = renderCase('invite_existing_account', {
      orgName: 'Acme',
      signInUrl: 'https://portal.test/i?grant=a&next=b',
    });
    expect(out.html).toContain('href="https://portal.test/i?grant=a&amp;next=b"');
    expect(out.html).not.toContain('grant=a&next=b"');
  });

  it('refuses a non-http(s) CTA href rather than emitting it', () => {
    // Attribute breakout plus `javascript:` in an email is a phishing vector.
    expect(() =>
      renderCase('invite_existing_account', {
        orgName: 'Acme',
        signInUrl: 'javascript:alert(1)',
      }),
    ).toThrow(/unsafe CTA href scheme/);
  });

  it('refuses an unparseable CTA href', () => {
    expect(() =>
      renderCase('invite_existing_account', {
        orgName: 'Acme',
        signInUrl: '" onmouseover="alert(1)',
      }),
    ).toThrow(/unsafe CTA href/);
  });
});
