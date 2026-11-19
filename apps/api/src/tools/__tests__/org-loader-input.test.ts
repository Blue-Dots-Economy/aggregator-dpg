import { describe, expect, it } from 'vitest';
import { parseCoordinatorsCsv, parseOrgsCsv } from '../org-loader-input.js';

const ORGS = [
  'name,parent,owner_name,owner_phone,owner_email,address_addressLocality,address_postalCode,notes',
  'Alpha,,Asha Rao,9876543210,Asha@Example.com,Pune,411001,hello',
  'Beta,Alpha,Bob,9123456780,bob@example.com,,,',
].join('\n');

const COORDS = [
  'org,name,phone,email,profile_types,region',
  'Alpha,Cara,9000000001,Cara@X.org,seeker; provider,north',
].join('\n');

describe('parseOrgsCsv', () => {
  it('parses a clean file', () => {
    const { rows, problems } = parseOrgsCsv(ORGS);
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      {
        line: 2,
        name: 'Alpha',
        parent: null,
        owner: { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' },
        extra: { notes: 'hello' },
        address: { addressLocality: 'Pune', postalCode: '411001' },
      },
      {
        line: 3,
        name: 'Beta',
        parent: 'Alpha',
        owner: { name: 'Bob', email: 'bob@example.com', phone: '9123456780' },
        extra: {},
        address: {},
      },
    ]);
  });

  it('returns the normalised header columns in file order', () => {
    const { columns } = parseOrgsCsv(
      ` Name ,PARENT,owner_name,owner_phone,owner_email,ADDRESS_POSTALCODE,webiste\n`,
    );
    expect(columns).toEqual([
      'name',
      'parent',
      'owner_name',
      'owner_phone',
      'owner_email',
      'address_postalCode',
      'webiste',
    ]);
  });

  it('gives identical rows for BOM, CRLF and trailing blank line', () => {
    const plain = parseOrgsCsv(ORGS);
    const messy = parseOrgsCsv('﻿' + ORGS.replace(/\n/g, '\r\n') + '\r\n\r\n');
    expect(messy).toEqual(plain);
  });

  it('reports a missing required column', () => {
    const { problems } = parseOrgsCsv('name,parent,owner_name,owner_phone\nA,,B,1');
    expect(problems).toContainEqual({
      file: 'orgs',
      line: 1,
      code: 'MISSING_COLUMN',
      field: 'owner_email',
    });
  });

  it('reports an empty required cell', () => {
    const { rows, problems } = parseOrgsCsv(
      'name,parent,owner_name,owner_phone,owner_email\nA,,,1,a@b.co',
    );
    expect(problems).toContainEqual({
      file: 'orgs',
      line: 2,
      code: 'REQUIRED',
      field: 'owner_name',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owner.name).toBe('');
  });

  it('trims and lowercases header names', () => {
    const { rows, problems } = parseOrgsCsv(
      ' Name , PARENT ,Owner_Name,owner_phone,OWNER_EMAIL\nA,,B,1,a@b.co',
    );
    expect(problems).toEqual([]);
    expect(rows[0]?.name).toBe('A');
  });
});

describe('parseCoordinatorsCsv', () => {
  it('parses profile_types, lowercases email and keeps unknown columns', () => {
    const { rows, problems } = parseCoordinatorsCsv(COORDS);
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      {
        line: 2,
        org: 'Alpha',
        name: 'Cara',
        email: 'cara@x.org',
        phone: '9000000001',
        profileTypes: ['seeker', 'provider'],
        extra: { region: 'north' },
      },
    ]);
  });

  it('gives identical rows for BOM, CRLF and trailing blank line', () => {
    const messy = parseCoordinatorsCsv('﻿' + COORDS.replace(/\n/g, '\r\n') + '\r\n\r\n');
    expect(messy).toEqual(parseCoordinatorsCsv(COORDS));
  });

  it('reports missing column and empty required cell', () => {
    const missing = parseCoordinatorsCsv('org,name,phone,email\nA,B,1,a@b.co');
    expect(missing.problems).toContainEqual({
      file: 'coordinators',
      line: 1,
      code: 'MISSING_COLUMN',
      field: 'profile_types',
    });
    const empty = parseCoordinatorsCsv('org,name,phone,email,profile_types\nA,,1,a@b.co,seeker');
    expect(empty.problems).toContainEqual({
      file: 'coordinators',
      line: 2,
      code: 'REQUIRED',
      field: 'name',
    });
  });

  it('returns rows even when a column is missing', () => {
    const { rows } = parseCoordinatorsCsv('org,name,phone,email\nA,B,1,a@b.co');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.profileTypes).toEqual([]);
  });
});

describe('line numbers and malformed rows', () => {
  const head = 'name,parent,owner_name,owner_phone,owner_email';

  it('keeps physical line numbers across a blank line', () => {
    const { rows } = parseOrgsCsv(`${head}\nA,,B,1,a@b.co\n\nC,,D,2,c@d.co`);
    expect(rows.map((r) => r.line)).toEqual([2, 4]);
  });

  it('flags a row with too many fields as MALFORMED_ROW', () => {
    const { rows, problems } = parseOrgsCsv(`${head}\nA,,B,1,a@b.co,extra`);
    expect(rows).toHaveLength(1);
    expect(problems).toContainEqual({ file: 'orgs', line: 2, code: 'MALFORMED_ROW' });
  });

  it('flags an unterminated quote as MALFORMED_ROW', () => {
    const { problems } = parseOrgsCsv(`${head}\nA,,"B,1,a@b.co`);
    expect(problems.some((p) => p.code === 'MALFORMED_ROW')).toBe(true);
  });

  it('does not flag blank lines or the trailing newline', () => {
    const { problems } = parseOrgsCsv(`${head}\nA,,B,1,a@b.co\n\n`);
    expect(problems).toEqual([]);
  });
});
