import { describe, it, expect, afterEach } from 'vitest';
import { parseProperties } from './parse-properties.js';
import { substitute, toPlainText, tokensUsed } from './substitute.js';
import {
  getMessage,
  assertMessagesComplete,
  emailMessageOverridePaths,
  _setEmailMessages,
} from './messages.js';
import { EMAIL_CASES, EMAIL_CASE_IDS, caseTokenTypes, requiredMessageKeys } from './email-cases.js';

afterEach(() => {
  _setEmailMessages(null);
});

describe('parseProperties', () => {
  it('splits at the FIRST = so values may contain more', () => {
    const out = parseProperties('a.cta=Open https://x.test/p?grant=abc&y=1');
    expect(out.entries.get('a.cta')).toBe('Open https://x.test/p?grant=abc&y=1');
    expect(out.malformedLines).toEqual([]);
  });

  it('ignores blanks and both comment markers', () => {
    const out = parseProperties('# hash\n! bang\n\n  \na.b=v');
    expect([...out.entries.keys()]).toEqual(['a.b']);
    expect(out.malformedLines).toEqual([]);
  });

  it('reports malformed lines by 1-based number rather than dropping them', () => {
    const out = parseProperties('a.b=v\nno-equals-here\n=leading');
    expect(out.entries.size).toBe(1);
    expect(out.malformedLines).toEqual([2, 3]);
  });

  it('lets a later duplicate win', () => {
    const out = parseProperties('a.b=first\na.b=second');
    expect(out.entries.get('a.b')).toBe('second');
  });
});

describe('substitute', () => {
  it('escapes text tokens', () => {
    const out = substitute('Hi {{name}}', { name: '<script>x</script>' }, { name: 'text' });
    expect(out).toBe('Hi &lt;script&gt;x&lt;/script&gt;');
  });

  it('inserts html tokens raw', () => {
    const out = substitute('{{block}} tail', { block: '<b>ok</b>' }, { block: 'html' });
    expect(out).toBe('<b>ok</b> tail');
  });

  it('treats an UNDECLARED token as text — safe default', () => {
    // Forgetting to declare a token must not open a raw-HTML hole.
    const out = substitute('{{x}}', { x: '<i>y</i>' });
    expect(out).toBe('&lt;i&gt;y&lt;/i&gt;');
  });

  it('leaves an unprovided token literal instead of blanking it', () => {
    expect(substitute('a {{missing}} b', {})).toBe('a {{missing}} b');
  });

  it('collects the tokens a fragment uses', () => {
    expect(tokensUsed('{{a}} and {{b}} and {{a}}').sort()).toEqual(['a', 'b']);
  });
});

describe('toPlainText', () => {
  it('strips the allowed tag vocabulary and decodes entities', () => {
    expect(toPlainText('<b>Bold</b> &amp; <a href="#">link</a>')).toBe('Bold & link');
  });

  it('decodes &amp; last so &amp;lt; does not become <', () => {
    expect(toPlainText('&amp;lt;')).toBe('&lt;');
  });

  it('turns <br> into a newline', () => {
    expect(toPlainText('a<br/>b')).toBe('a\nb');
  });
});

describe('email case registry', () => {
  it('every declared key exists in the bundled defaults', () => {
    // The bundled layer must be complete — a hole is a build defect.
    expect(() => assertMessagesComplete()).not.toThrow();
  });

  it('every default copy fragment only uses tokens its case declares', () => {
    const problems: string[] = [];
    for (const caseId of EMAIL_CASE_IDS) {
      const declared = new Set(Object.keys(caseTokenTypes(caseId)));
      for (const key of EMAIL_CASES[caseId]!.keys) {
        for (const token of tokensUsed(getMessage(`${caseId}.${key}`))) {
          if (!declared.has(token)) problems.push(`${caseId}.${key}: {{${token}}}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('requiredMessageKeys covers every case', () => {
    expect(requiredMessageKeys().length).toBeGreaterThan(EMAIL_CASE_IDS.length);
  });

  it('rejects an unknown case rather than silently escaping everything', () => {
    expect(() => caseTokenTypes('nope')).toThrow(/unknown email case/);
  });
});

describe('message lookup', () => {
  it('falls back to the key itself when absent — visibly wrong beats blank', () => {
    _setEmailMessages(new Map());
    expect(getMessage('applicant_approved.subject')).toBe('applicant_approved.subject');
  });

  it('assertMessagesComplete fails loudly on a hole', () => {
    _setEmailMessages(new Map([['applicant_approved.subject', 'x']]));
    expect(() => assertMessagesComplete()).toThrow(/missing \d+ key/);
  });
});

describe('override path precedence', () => {
  it('orders network, then brand, then the instance escape hatch', () => {
    const paths = emailMessageOverridePaths({
      AGGREGATOR_NETWORK: 'blue_dot',
      AGGREGATOR_BRAND: 'up-gzb',
      EMAIL_MESSAGES_PATH: '/etc/aggregator/messages.properties',
    } as NodeJS.ProcessEnv);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toContain('blue_dot/emails/messages.properties');
    expect(paths[1]).toContain('blue_dot/up-gzb/emails/messages.properties');
    expect(paths[2]).toBe('/etc/aggregator/messages.properties');
  });

  it('omits the brand layer when no brand is set', () => {
    const paths = emailMessageOverridePaths({
      AGGREGATOR_NETWORK: 'purple_dot',
    } as NodeJS.ProcessEnv);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('purple_dot/emails/messages.properties');
  });
});
