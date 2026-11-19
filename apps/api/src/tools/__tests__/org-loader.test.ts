import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import {
  OrganisationStoreFake,
  buildOrganisation,
  _setOrganisationStore,
} from '../../services/organisation-store/index.js';
import { UserStoreFake, _setUserStore } from '../../services/user-store/index.js';
import { IdpAdminFake, _setIdpAdmin } from '../../services/idp-admin/index.js';
import { _setConsentLedger } from '../../services/consent-ledger/index.js';
import { _setNetworkConfig } from '../../services/network-config.js';
import { _setSignalStackWriter } from '../../services/signalstack.js';
import { _resetOrgSchemaValidator } from '../../services/org-schema-validator.js';
import type { ReportRow } from '../org-loader-apply.js';
import { REPORT_COLUMNS, _main, reportCsv } from '../org-loader-command.js';

vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'nf-admin@test.local';
});

const ROOT = '00000000-0000-4000-8000-000000000001';
const ORGS_HEADER = 'name,parent,owner_name,owner_phone,owner_email';
const COORDS_HEADER = 'org,name,phone,email,profile_types';

let dir: string;
let orgStore: OrganisationStoreFake;
let userStore: UserStoreFake;
let idp: IdpAdminFake;
let ledger: ConsentLedgerFake;
let mailer: FakeMailer;

/**
 * Runs the command in-process with fake streams.
 *
 * @returns The exit code, stdout, stderr and both together (`out`).
 */
async function cli(
  argv: string[],
  stdin = '',
): Promise<{ code: number; out: string; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await _main(argv, {
    readStdin: async () => stdin,
    writeStdout: (t) => {
      stdout += t;
    },
    writeStderr: (t) => {
      stderr += t;
    },
  });
  return { code, out: stdout + stderr, stdout, stderr };
}

async function file(name: string, lines: string[]): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, `${lines.join('\n')}\n`);
  return p;
}

/** A two-org tree with one coordinator, as files. */
async function treeFiles(): Promise<{ orgs: string; coordinators: string }> {
  return {
    orgs: await file('orgs.csv', [
      ORGS_HEADER,
      'Top,,Ravi Kumar,9876500001,ravi@alpha.org',
      'Child,Top,Ravi Kumar,9876500001,ravi@alpha.org',
    ]),
    coordinators: await file('coordinators.csv', [
      COORDS_HEADER,
      'Child,Asha Kumari,9876511111,asha@alpha.org,seeker',
    ]),
  };
}

async function orgCount(): Promise<number> {
  const page = await orgStore.search({ orgIds: null, namePrefix: '', limit: 100 });
  if (!page.ok) throw new Error('search failed');
  return page.value.rows.length;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'org-loader-'));
  orgStore = new OrganisationStoreFake();
  orgStore.seedRoot(
    buildOrganisation({
      id: ROOT,
      displayName: 'Blue Dots Network',
      depth: 0,
      status: 'active',
      ownerEmail: 'nf-admin@test.local',
    }),
  );
  _setOrganisationStore(orgStore);
  userStore = new UserStoreFake();
  _setUserStore(userStore);
  idp = new IdpAdminFake();
  _setIdpAdmin(idp);
  _setSignalStackWriter(new SignalStackWriterFake());
  ledger = new ConsentLedgerFake();
  _setConsentLedger(ledger);
  mailer = new FakeMailer();
  _setMailer(mailer);
  const base = buildBlueDotConfig();
  _setNetworkConfig(
    buildBlueDotConfig({
      aggregator: {
        ...base.aggregator,
        organisation: { hierarchy: { max_depth: 5, max_total_orgs: 50 } },
      },
    }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  _setSignalStackWriter(null);
  _setConsentLedger(null);
  _setNetworkConfig(null);
  vi.unstubAllEnvs();
  _resetOrgSchemaValidator();
});

describe('org-loader usage', () => {
  it('exits 2 with no subcommand', async () => {
    const r = await cli([]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('usage:');
  });

  it('exits 2 for an unknown subcommand', async () => {
    expect((await cli(['load'])).code).toBe(2);
  });

  it('exits 2 when apply has no --operator', async () => {
    const files = await treeFiles();
    const r = await cli(['apply', '--orgs', files.orgs, '--coordinators', files.coordinators]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('--operator');
    expect(await orgCount()).toBe(0);
  });

  it('exits 2 when the operator has whitespace or a colon', async () => {
    const files = await treeFiles();
    const r = await cli(['apply', '--orgs', files.orgs, '--operator', 'a:b']);
    expect(r.code).toBe(2);
  });

  it('exits 2 when neither file is given', async () => {
    expect((await cli(['check'])).code).toBe(2);
    expect((await cli(['apply', '--operator', 'ops'])).code).toBe(2);
  });

  it('exits 2 when a file cannot be read', async () => {
    const r = await cli(['check', '--orgs', path.join(dir, 'missing.csv')]);
    expect(r.code).toBe(2);
  });

  it('exits 2 when the report file already exists, before applying anything', async () => {
    const files = await treeFiles();
    const report = await file('report.csv', ['old']);
    const r = await cli(['apply', '--orgs', files.orgs, '--operator', 'ops', '--report', report]);
    expect(r.code).toBe(2);
    expect(await orgCount()).toBe(0);
  });

  it('exits 2 when template has no valid --kind', async () => {
    expect((await cli(['template'])).code).toBe(2);
    expect((await cli(['template', '--kind', 'people'])).code).toBe(2);
  });

  it('exits 2 on an unknown flag, a stray argument or a flag another command takes', async () => {
    const files = await treeFiles();
    for (const argv of [
      ['check', '--orgs', files.orgs, '--dry-run', 'yes'],
      ['check', '--orgs', files.orgs, 'extra'],
      ['check', '--orgs', files.orgs, '--operator', 'ops'],
      ['check', '--orgs'],
      ['check', '--orgs', files.orgs, '--orgs', files.orgs],
    ]) {
      const r = await cli(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr).toContain('usage:');
    }
    expect(await orgCount()).toBe(0);
  });

  it('exits 2 when both inputs are stdin', async () => {
    const r = await cli(['check', '--orgs', '-', '--coordinators', '-']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('only one input');
  });
});

describe('org-loader check', () => {
  it('passes a clean input and writes nothing', async () => {
    const files = await treeFiles();
    const r = await cli(['check', '--orgs', files.orgs, '--coordinators', files.coordinators]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('CHECK PASSED');
    expect(await orgCount()).toBe(0);
  });

  it('accepts the orgs file alone', async () => {
    const files = await treeFiles();
    expect((await cli(['check', '--orgs', files.orgs])).code).toBe(0);
  });

  it('prints each problem as file:line code field, with no row data', async () => {
    const orgs = await file('orgs.csv', [
      ORGS_HEADER,
      'Top,,Ravi Kumar,9876500001,ravi@alpha.org',
      'Child,Nowhere,Meena Rao,12,meena@alpha.org',
    ]);
    const r = await cli(['check', '--orgs', orgs]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`${orgs}:3 [A-Z_]+ [a-z_]+`));
    expect(r.out).toContain('CHECK FAILED');
    for (const pii of ['Meena', 'meena@alpha.org', 'Nowhere', 'Ravi', '9876500001']) {
      expect(r.out).not.toContain(pii);
    }
  });
});

describe('org-loader check: columns', () => {
  it('fails on a misspelt org column, naming the header', async () => {
    const orgs = await file('orgs.csv', [
      `${ORGS_HEADER},webiste`,
      'Top,,Ravi Kumar,9876500001,ravi@alpha.org,https://alpha.org',
    ]);
    const r = await cli(['check', '--orgs', orgs]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`${orgs}:1 UNKNOWN_COLUMN webiste`);
    expect(r.stdout).toContain('CHECK FAILED');
  });
});

describe('org-loader apply', () => {
  it('refuses with exit 1 on any problem and applies nothing', async () => {
    const orgs = await file('orgs.csv', [
      ORGS_HEADER,
      'Top,,Ravi Kumar,9876500001,ravi@alpha.org',
      'Child,Top,Meena Rao,not-a-phone,meena@alpha.org',
    ]);
    const report = path.join(dir, 'report.csv');
    const r = await cli(['apply', '--orgs', orgs, '--operator', 'ops', '--report', report]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${orgs}:3 INVALID_PHONE owner_phone`);
    expect(await orgCount()).toBe(0);
    const owner = await idp.findByEmail('ravi@alpha.org');
    expect(owner.ok && owner.value).toBeNull();
    await expect(readFile(report, 'utf8')).rejects.toThrow();
  });

  it('applies, exits 0 and writes a report with every ReportRow field in order', async () => {
    const files = await treeFiles();
    const report = path.join(dir, 'report.csv');
    const r = await cli([
      'apply',
      '--orgs',
      files.orgs,
      '--coordinators',
      files.coordinators,
      '--operator',
      'ops',
      '--report',
      report,
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('APPLY COMPLETE');
    expect(r.out).not.toContain('ravi@alpha.org');
    expect(r.out).not.toContain('Asha');

    const lines = (await readFile(report, 'utf8')).trim().split('\n');
    expect(lines[0]).toBe(
      'kind,line,name,email,outcome,orgId,userId,signalsOrgId,rolesSync,errorCode',
    );
    expect(lines[0]).toBe(REPORT_COLUMNS.join(','));
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^org,2,Top,ravi@alpha\.org,created,[0-9a-f-]{36},[0-9a-f-]+,,off,$/);
    expect(lines[2]).toMatch(/^org,3,Child,ravi@alpha\.org,created,/);
    expect(lines[3]).toMatch(
      /^coordinator,2,Asha Kumari,asha@alpha\.org,created,[0-9a-f-]{36},[0-9a-f-]+,[^,]+,off,$/,
    );
    expect(ledger.list()).toHaveLength(0);
    expect(mailer.outbox).toHaveLength(0);
    expect(await orgCount()).toBe(2);
  });

  it('reruns with exit 0 and every row already_loaded', async () => {
    const files = await treeFiles();
    const args = ['apply', '--orgs', files.orgs, '--coordinators', files.coordinators];
    const first = await cli([...args, '--operator', 'ops', '--report', path.join(dir, 'r1.csv')]);
    expect(first.code).toBe(0);
    const again = path.join(dir, 'r2.csv');
    const second = await cli([...args, '--operator', 'ops', '--report', again]);
    expect(second.code).toBe(0);
    const outcomes = (await readFile(again, 'utf8'))
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split(',')[4]);
    expect(outcomes).toEqual(['already_loaded', 'already_loaded', 'already_loaded']);
  });

  it('exits 1 and reports the failed row when a row fails', async () => {
    const files = await treeFiles();
    idp.createUser = async () => ({
      ok: false as const,
      error: { code: 'IDP_UNAVAILABLE' as const, message: 'down' },
    });
    const report = path.join(dir, 'report.csv');
    const r = await cli(['apply', '--orgs', files.orgs, '--operator', 'ops', '--report', report]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('APPLY FAILED');
    const lines = (await readFile(report, 'utf8')).trim().split('\n');
    expect(lines[1]).toMatch(/^org,2,Top,ravi@alpha\.org,failed,.*,IDP_UNAVAILABLE$/);
    expect(lines[2]).toMatch(/^org,3,Child,ravi@alpha\.org,not_run,/);
  });
});

describe('reportCsv', () => {
  it('neutralises spreadsheet formulas and quotes commas', () => {
    const row: ReportRow = {
      kind: 'org',
      line: 2,
      name: '=HYPERLINK("x")',
      email: '+a@b.c',
      outcome: 'created',
      orgId: 'o, 1',
    };
    const [, line] = reportCsv([row]).trim().split('\n');
    expect(line).toBe(`org,2,"'=HYPERLINK(""x"")",'+a@b.c,created,"o, 1",,,,`);
  });
});

describe('org-loader template', () => {
  it('prints each header from the instance schemas, without consent', async () => {
    vi.stubEnv('AGGREGATOR_NETWORK', 'blue_dot');
    vi.stubEnv('AGGREGATOR_BRAND', 'up-gzb');
    _resetOrgSchemaValidator();
    const o = await cli(['template', '--kind', 'orgs']);
    const c = await cli(['template', '--kind', 'coordinators']);
    expect(o.code).toBe(0);
    expect(c.code).toBe(0);
    expect(o.stdout.split('\n')).toHaveLength(2);
    const orgs = o.stdout.trim().split(',');
    const coords = c.stdout.trim().split(',');
    expect(orgs.slice(0, 5)).toEqual(ORGS_HEADER.split(','));
    expect(orgs).toContain('owner_email');
    expect(orgs).toContain('aggregator_type');
    expect(orgs).toContain('management_type');
    expect(orgs).toContain('address_postalCode');
    for (const fixed of ['consent', 'owner', 'display_name', 'address']) {
      expect(orgs).not.toContain(fixed);
    }
    expect(coords.slice(0, 5)).toEqual(COORDS_HEADER.split(','));
    expect(coords).toContain('sub_org_name');
    for (const fixed of ['consent', 'contact', 'type', 'locations', 'url']) {
      expect(coords).not.toContain(fixed);
    }
  });
});

describe('org-loader stdin and stdout', () => {
  const ORGS = [
    ORGS_HEADER,
    'Top,,Ravi Kumar,9876500001,ravi@alpha.org',
    'Child,Top,Ravi Kumar,9876500001,ravi@alpha.org',
  ];

  it('checks an input read from stdin, labelling problems as stdin', async () => {
    const ok = await cli(['check', '--orgs', '-'], `${ORGS.join('\n')}\n`);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('rows: orgs=2 coordinators=0');
    const bad = await cli(
      ['check', '--orgs', '-'],
      `${ORGS_HEADER}\nTop,,Ravi Kumar,12,ravi@alpha.org\n`,
    );
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('orgs(stdin):2 INVALID_PHONE owner_phone');
  });

  it('writes only the report CSV to stdout with --report -, everything else to stderr', async () => {
    const r = await cli(
      ['apply', '--orgs', '-', '--operator', 'ops', '--report', '-'],
      `${ORGS.join('\n')}\n`,
    );
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe(REPORT_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^org,2,Top,ravi@alpha\.org,created,/);
    expect(lines[2]).toMatch(/^org,3,Child,ravi@alpha\.org,created,/);
    expect(r.stderr).toContain('APPLY COMPLETE');
    expect(r.stderr).toContain('report: stdout');
    expect(r.stderr).not.toContain('ravi@alpha.org');
  });

  it('writes nothing to stdout when --report - refuses on a problem', async () => {
    const r = await cli(
      ['apply', '--orgs', '-', '--operator', 'ops', '--report', '-'],
      `${ORGS_HEADER}\nTop,,Ravi Kumar,12,ravi@alpha.org\n`,
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('REFUSED');
    expect(await orgCount()).toBe(0);
  });

  it('writes the report to stdout when --report is not given', async () => {
    const files = await treeFiles();
    const r = await cli(['apply', '--orgs', files.orgs, '--operator', 'ops']);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe(REPORT_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    expect(r.stderr).toContain('report: stdout');
    expect(r.stderr).toContain('APPLY COMPLETE');
  });
});
