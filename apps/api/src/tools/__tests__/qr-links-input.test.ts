import { describe, expect, it } from 'vitest';
import { LINK_INPUT_PROBLEM, parseLinksCsv } from '../qr-links-input.js';

const HEADER = 'coordinator_email,profile_type,voice_bot,link_name,expires_on';

describe('parseLinksCsv', () => {
  it('parses a clean file, trimming cells and lowercasing the email', () => {
    const text = [
      HEADER,
      ' Raj@X.org , seeker , bot_a , camp-1 , 2027-01-31 ',
      'b@x.org,provider,,,',
    ].join('\n');
    const { rows, problems } = parseLinksCsv(text);
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      {
        line: 2,
        coordinatorEmail: 'raj@x.org',
        profileType: 'seeker',
        voiceBot: 'bot_a',
        linkName: 'camp-1',
        expiresOn: '2027-01-31',
      },
      {
        line: 3,
        coordinatorEmail: 'b@x.org',
        profileType: 'provider',
        voiceBot: '',
        linkName: '',
        expiresOn: '',
      },
    ]);
  });

  it('strips a BOM, accepts CRLF and skips blank lines while keeping line numbers', () => {
    const text = `﻿${HEADER}\r\na@x.org,seeker,,,\r\n\r\n,,,,\r\nb@x.org,seeker,,,\r\n`;
    const { rows, problems } = parseLinksCsv(text);
    expect(problems).toEqual([]);
    expect(rows.map((r) => [r.line, r.coordinatorEmail])).toEqual([
      [2, 'a@x.org'],
      [5, 'b@x.org'],
    ]);
  });

  it('accepts only the required columns', () => {
    const { rows, problems } = parseLinksCsv('profile_type,coordinator_email\nseeker,a@x.org');
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({ coordinatorEmail: 'a@x.org', profileType: 'seeker' });
  });

  it('reports a missing required column', () => {
    const { problems } = parseLinksCsv('coordinator_email,voice_bot\na@x.org,');
    expect(problems).toContainEqual({
      line: 1,
      code: LINK_INPUT_PROBLEM.MISSING_COLUMN,
      field: 'profile_type',
    });
  });

  it('reports an unknown column', () => {
    const { problems } = parseLinksCsv(`${HEADER},expiry\na@x.org,seeker,,,,x`);
    expect(problems).toEqual([
      { line: 1, code: LINK_INPUT_PROBLEM.UNKNOWN_COLUMN, field: 'expiry' },
    ]);
  });

  it('reports an empty required cell', () => {
    const { problems } = parseLinksCsv(`${HEADER}\n,seeker,,,\na@x.org,,,,`);
    expect(problems).toEqual([
      { line: 2, code: LINK_INPUT_PROBLEM.REQUIRED, field: 'coordinator_email' },
      { line: 3, code: LINK_INPUT_PROBLEM.REQUIRED, field: 'profile_type' },
    ]);
  });

  it('reports a malformed row', () => {
    const { problems } = parseLinksCsv(`${HEADER}\na@x.org,seeker,,,,extra`);
    expect(problems).toEqual([{ line: 2, code: LINK_INPUT_PROBLEM.MALFORMED_ROW }]);
  });
});
