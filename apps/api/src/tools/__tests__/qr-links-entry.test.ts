import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The api app directory, where `tsx` resolves. */
const API_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const ENTRY = fileURLToPath(new URL('../qr-links.ts', import.meta.url));

/** A cold `tsx` start loads the whole API module graph. */
const SPAWN_TIMEOUT_MS = 60_000;

let emptyConfig: string;

beforeAll(async () => {
  emptyConfig = await mkdtemp(path.join(os.tmpdir(), 'qr-links-entry-'));
});

afterAll(async () => {
  await rm(emptyConfig, { recursive: true, force: true });
});

/** Runs the entry with `stdin` piped in and resolves with its exit code and output. */
function runEntry(
  args: string[],
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', ENTRY, ...args],
      {
        cwd: API_DIR,
        timeout: SPAWN_TIMEOUT_MS,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          LOG_LEVEL: 'info',
          LOG_DESTINATION: 'stdout',
          CONFIG_ROOT: emptyConfig,
          DATABASE_URL: 'postgres://localhost:1/qr_links_entry_test',
        },
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          stdout,
          stderr,
        });
      },
    );
    child.stdin?.end(stdin);
  });
}

describe('qr-links entry', () => {
  it(
    'sends log lines to stderr even when the env says LOG_DESTINATION=stdout',
    async () => {
      // An empty CONFIG_ROOT makes the network-config load log a failure line, so a log line is written.
      const { code, stdout, stderr } = await runEntry(
        ['check', '--links', '-'],
        'coordinator_email,profile_type\nraj@x.org,seeker\n',
      );
      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('"operation":"network-config.load"');
    },
    SPAWN_TIMEOUT_MS,
  );
});
