import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The api app directory, where `tsx` resolves. */
const API_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const ENTRY = fileURLToPath(new URL('../org-loader.ts', import.meta.url));

/** A cold `tsx` start loads the whole API module graph. */
const SPAWN_TIMEOUT_MS = 60_000;

let emptyConfig: string;

beforeAll(async () => {
  emptyConfig = await mkdtemp(path.join(os.tmpdir(), 'org-loader-entry-'));
});

afterAll(async () => {
  await rm(emptyConfig, { recursive: true, force: true });
});

describe('org-loader entry', () => {
  it(
    'sends log lines to stderr even when the env says LOG_DESTINATION=stdout',
    async () => {
      // An empty CONFIG_ROOT makes the network-config load log a failure line, so a log line is written.
      const { stdout, stderr } = await run(
        process.execPath,
        ['--import', 'tsx', ENTRY, 'template', '--kind', 'orgs'],
        {
          cwd: API_DIR,
          timeout: SPAWN_TIMEOUT_MS,
          env: {
            ...process.env,
            NODE_ENV: 'production',
            LOG_LEVEL: 'info',
            LOG_DESTINATION: 'stdout',
            CONFIG_ROOT: emptyConfig,
            DATABASE_URL: 'postgres://localhost:1/org_loader_entry_test',
          },
        },
      );
      const lines = stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^name,parent,owner_name,owner_phone,owner_email/);
      expect(stderr).toContain('"operation":"network-config.load"');
    },
    SPAWN_TIMEOUT_MS,
  );
});
