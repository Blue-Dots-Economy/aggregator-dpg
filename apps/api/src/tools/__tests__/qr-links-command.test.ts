import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setNetworkConfig } from '../../services/network-config.js';
import { _setUserStore } from '../../services/user-store/index.js';
import { _setRegistrationLinksStore } from '../../services/registration-links-store/index.js';
import { buildPublicUrl } from '../../services/registration-links/create.js';
import { LINK_REPORT_COLUMNS, _main, linksReportCsv } from '../qr-links-command.js';
import { LINKS_HEADER, LinksStoreFake, seededUsers, twoOptionConfig } from './qr-links-fixtures.js';

let links: LinksStoreFake;

/**
 * Runs the command in-process with fake streams.
 *
 * @returns The exit code, stdout and stderr.
 */
async function cli(
  argv: string[],
  stdin = '',
): Promise<{ code: number; stdout: string; stderr: string }> {
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
  return { code, stdout, stderr };
}

function sheet(...lines: string[]): string {
  return `${[LINKS_HEADER, ...lines].join('\n')}\n`;
}

const CLEAN = sheet('raj@x.org,seeker,,camp-a,', 'meera@x.org,seeker,,camp-b,');
const REPORT_HEADER = 'line,coordinator_email,profile_type,voice_bot,slug,url,outcome,error_code';

beforeEach(() => {
  _setUserStore(seededUsers());
  links = new LinksStoreFake();
  _setRegistrationLinksStore(links);
  _setNetworkConfig(twoOptionConfig());
});

afterEach(() => {
  _setUserStore(null);
  _setRegistrationLinksStore(null);
  vi.unstubAllEnvs();
});

describe('qr-links usage', () => {
  it.each([
    ['no command', []],
    ['an unknown command', ['load', '--links', '-']],
    ['an unknown flag', ['check', '--links', '-', '--orgs', '-']],
    ['a file path for --links', ['check', '--links', 'seekers.csv']],
    ['no --links', ['check']],
    ['a flag with no value', ['check', '--links']],
    ['a repeated flag', ['check', '--links', '-', '--links', '-']],
    ['apply without --operator', ['apply', '--links', '-']],
    ['an invalid operator', ['apply', '--links', '-', '--operator', 'a:b']],
  ])('exits 2 on %s and writes nothing to stdout', async (_name, argv) => {
    const { code, stdout, stderr } = await cli(argv, CLEAN);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('usage error:');
  });
});

describe('qr-links check', () => {
  it('passes a clean sheet with nothing on stdout', async () => {
    const { code, stdout, stderr } = await cli(['check', '--links', '-'], CLEAN);
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('CHECK PASSED');
    expect(links.creates).toEqual([]);
  });

  it('prints each problem as <line> <code> <field> and exits 1', async () => {
    const { code, stdout, stderr } = await cli(
      ['check', '--links', '-', '--operator', 'asha'],
      sheet('nobody@x.org,seeker,,,', 'raj@x.org,seeker,,Bad Name,'),
    );
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('\n2 UNKNOWN_COORDINATOR coordinator_email\n');
    expect(stderr).toContain('\n3 INVALID_LINK_NAME link_name\n');
    expect(stderr).toContain('CHECK FAILED');
    expect(stderr).not.toContain('nobody@x.org');
  });
});

describe('qr-links apply', () => {
  it('creates the links and writes only the report CSV to stdout', async () => {
    const { code, stdout, stderr } = await cli(
      ['apply', '--links', '-', '--operator', 'asha'],
      CLEAN,
    );
    expect(code).toBe(0);
    expect(stdout).toBe(
      `${REPORT_HEADER}\n` +
        `2,raj@x.org,seeker,bot_a,camp-a,${buildPublicUrl('raj-org', 'camp-a')},created,\n` +
        `3,meera@x.org,seeker,bot_a,camp-b,${buildPublicUrl('meera-org', 'camp-b')},created,\n`,
    );
    expect(stderr).toContain('as provisioned:asha');
    expect(stderr).toContain('APPLY COMPLETE');
  });

  it('reports already_loaded on a rerun without creating again', async () => {
    await cli(['apply', '--links', '-', '--operator', 'asha'], CLEAN);
    const { code, stdout } = await cli(['apply', '--links', '-', '--operator', 'asha'], CLEAN);
    expect(code).toBe(0);
    expect(
      stdout
        .trim()
        .split('\n')
        .slice(1)
        .map((l) => l.split(',')[6]),
    ).toEqual(['already_loaded', 'already_loaded']);
    expect(links.creates).toHaveLength(2);
  });

  it('exits 1 at the first failure and reports the rest as not_run', async () => {
    links.failCreateCall = 2;
    const { code, stdout, stderr } = await cli(
      ['apply', '--links', '-', '--operator', 'asha'],
      sheet('raj@x.org,seeker,,,', 'meera@x.org,seeker,,,', 'raj@x.org,provider,,,'),
    );
    expect(code).toBe(1);
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toBe(REPORT_HEADER);
    expect(lines.slice(1).map((l) => l.split(',').slice(6).join(','))).toEqual([
      'created,',
      'failed,DB_UNAVAILABLE',
      'not_run,',
    ]);
    expect(stderr).toContain('APPLY FAILED at line 3 DB_UNAVAILABLE');
  });

  it('refuses a sheet with problems and writes no report', async () => {
    const { code, stdout, stderr } = await cli(
      ['apply', '--links', '-', '--operator', 'asha'],
      sheet('nobody@x.org,seeker,,,'),
    );
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('REFUSED');
    expect(links.creates).toEqual([]);
  });
});

describe('linksReportCsv', () => {
  it('lists the report columns in the spec order', () => {
    expect(LINK_REPORT_COLUMNS.join(',')).toBe(REPORT_HEADER);
  });

  it('neutralises formula cells and quotes commas (Review Focus 5)', () => {
    const csv = linksReportCsv([
      {
        line: 2,
        coordinatorEmail: '=HYPERLINK("http://evil","x")',
        profileType: '+seeker',
        voiceBot: '@bot',
        slug: '-camp',
        url: 'https://x/a,b',
        outcome: 'failed',
        errorCode: 'DB_UNAVAILABLE',
      },
    ]);
    expect(csv.split('\n')[1]).toBe(
      `2,"'=HYPERLINK(""http://evil"",""x"")",'+seeker,'@bot,'-camp,"https://x/a,b",failed,DB_UNAVAILABLE`,
    );
  });
});
