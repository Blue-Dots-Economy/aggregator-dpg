/**
 * Unit tests for `readJournal` in `db/migrate-core.ts` (`@aggregator-dpg/api`).
 *
 * Reads the shipped journal and journals written to a temporary folder.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJournal } from '../migrate-core.js';

const SHIPPED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/migrations',
);

describe('readJournal', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'journal-'));
    await mkdir(path.join(dir, 'meta'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeJournal(body: unknown): Promise<void> {
    await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify(body), 'utf8');
  }

  it('reads the shipped journal in order', async () => {
    const entries = await readJournal(SHIPPED);
    expect(entries.length).toBeGreaterThan(0);
    const whens = entries.map((e) => e.when);
    expect(whens.every((w) => Number.isInteger(w))).toBe(true);
    expect(entries.every((e) => typeof e.tag === 'string' && e.tag.length > 0)).toBe(true);
  });

  it('returns idx, when and tag of each entry', async () => {
    await writeJournal({
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: 1700000000000, tag: '0000_init', breakpoints: true }],
    });
    expect(await readJournal(dir)).toEqual([{ idx: 0, when: 1700000000000, tag: '0000_init' }]);
  });

  it('refuses a journal without an entries list', async () => {
    await writeJournal({ version: '7' });
    await expect(readJournal(dir)).rejects.toThrow(/journal/);
  });

  it('refuses an entry whose when is not a number', async () => {
    await writeJournal({ entries: [{ idx: 0, when: '1700000000000', tag: '0000_init' }] });
    await expect(readJournal(dir)).rejects.toThrow(/journal.*entries\.0\.when/);
  });
});
