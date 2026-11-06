import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ESLint } from 'eslint';

const root = join(import.meta.dirname, '..');
const eslint = new ESLint({ cwd: root });

/** Lints `code` as if it lived at `filePath` (relative to the repo root). */
async function lint(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result.messages;
}

/** Messages for one rule, as `[severity, ...]`. Severity 1 = warn, 2 = error. */
function severities(messages, ruleId) {
  return messages.filter((m) => m.ruleId === ruleId).map((m) => m.severity);
}

const PKG_FILE = 'packages/shared-primitives/src/lint-probe.ts';
const WEB_FILE = 'apps/web/src/components/console/LintProbe.tsx';

// ── import-x/no-cycle ──────────────────────────────────────────────────────

const FIXTURE_PARENT = join(root, 'packages', 'shared-primitives', 'src');
const FIXTURE_PREFIX = '.lint-cycle-';

/** Writes `files` (name → source) into the fixture folder. */
function writeFixtures(files) {
  for (const [name, source] of Object.entries(files)) writeFileSync(join(cycleDir, name), source);
}

/** Lints one fixture file from disk, so import-x can follow its imports. */
async function lintFixture(name) {
  const [result] = await eslint.lintFiles([relative(root, join(cycleDir, name))]);
  return severities(result.messages, 'import-x/no-cycle');
}

let cycleDir;
before(() => {
  // A run that was killed leaves its fixture behind; remove it so it cannot fail `pnpm lint`.
  for (const entry of readdirSync(FIXTURE_PARENT)) {
    if (entry.startsWith(FIXTURE_PREFIX)) {
      rmSync(join(FIXTURE_PARENT, entry), { recursive: true, force: true });
    }
  }
  cycleDir = mkdtempSync(join(FIXTURE_PARENT, FIXTURE_PREFIX));
  writeFixtures({
    'a.ts': "import { b } from './b.js';\nexport const a = (): number => b() + 1;\n",
    'b.ts': "import { a } from './a.js';\nexport const b = (): number => (a() > 0 ? 1 : 0);\n",
    // d/e and f/g are the same loop; only d uses `import type`.
    'd.ts': "import type { E } from './e.js';\nexport const d = 1;\nexport type D = E;\n",
    'e.ts': "import { d } from './d.js';\nexport type E = { v: number };\nexport const e = d;\n",
    'f.ts': "import { G } from './g.js';\nexport const f = 1;\nexport type F = G;\n",
    'g.ts': "import { f } from './f.js';\nexport type G = { v: number };\nexport const g = f;\n",
  });
});
after(() => rmSync(cycleDir, { recursive: true, force: true }));

test('import-x/no-cycle reports a cycle between two TypeScript files', async () => {
  assert.deepEqual(await lintFixture('a.ts'), [2]);
});

test('import-x/no-cycle reports a loop closed by a value import', async () => {
  assert.deepEqual(await lintFixture('f.ts'), [2]);
});

test('import-x/no-cycle ignores the same loop when one side is a type-only import', async () => {
  assert.deepEqual(await lintFixture('d.ts'), []);
});

// ── eqeqeq ─────────────────────────────────────────────────────────────────

test('eqeqeq fails on == between values', async () => {
  const m = await lint(PKG_FILE, 'export const f = (a: number, b: number): boolean => a == b;\n');
  assert.deepEqual(severities(m, 'eqeqeq'), [2]);
});

test('eqeqeq allows == null', async () => {
  const m = await lint(PKG_FILE, 'export const f = (a: number | null): boolean => a == null;\n');
  assert.deepEqual(severities(m, 'eqeqeq'), []);
});

// ── @typescript-eslint/consistent-type-assertions ──────────────────────────

const CAST = 'interface Foo { x: number }\nexport const f = (v: unknown): Foo => v as Foo;\n';
const RULE_CAST = '@typescript-eslint/consistent-type-assertions';

test('an `as` cast in production code is an error', async () => {
  assert.deepEqual(severities(await lint(PKG_FILE, CAST), RULE_CAST), [2]);
});

test('allows `as const`', async () => {
  const m = await lint(PKG_FILE, "export const roles = ['a', 'b'] as const;\n");
  assert.deepEqual(severities(m, RULE_CAST), []);
});

for (const file of [
  'packages/shared-primitives/src/ids.test.ts',
  'apps/web/src/__tests__/lib/probe.test.tsx',
  'packages/signalstack-writer/src/testing.ts',
  'packages/rbac/src/testing/index.ts',
  'apps/api/src/test-setup.ts',
]) {
  test(`does not check casts in test code: ${file}`, async () => {
    assert.deepEqual(severities(await lint(file, CAST), RULE_CAST), []);
  });
}

// ── React hooks (web only) ─────────────────────────────────────────────────

test('react-hooks/rules-of-hooks is an error in the web app', async () => {
  const code = `import { useState } from 'react';
export function Probe({ on }: { on: boolean }) {
  if (on) {
    const [v] = useState(0);
    return <p>{v}</p>;
  }
  return null;
}
`;
  assert.deepEqual(severities(await lint(WEB_FILE, code), 'react-hooks/rules-of-hooks'), [2]);
});

test('react-hooks/set-state-in-effect is an error for state copied in an effect', async () => {
  const code = `import { useEffect, useState } from 'react';
export function Probe({ items }: { items: string[] }) {
  const [visible, setVisible] = useState(items);
  useEffect(() => {
    setVisible(items.filter((i) => i !== ''));
  }, [items]);
  return <p>{visible.length}</p>;
}
`;
  assert.deepEqual(severities(await lint(WEB_FILE, code), 'react-hooks/set-state-in-effect'), [2]);
});

test('react-hooks/exhaustive-deps is an error for a missing dependency', async () => {
  const code = `import { useEffect } from 'react';
export function Probe({ id }: { id: string }) {
  useEffect(() => {
    document.title = id;
  }, []);
  return null;
}
`;
  assert.deepEqual(severities(await lint(WEB_FILE, code), 'react-hooks/exhaustive-deps'), [2]);
});

// ── Next.js (web only) ─────────────────────────────────────────────────────

test('@next/next rules run in the web app as errors', async () => {
  const code = 'export function Probe() {\n  return <img src="/x.png" alt="x" />;\n}\n';
  assert.deepEqual(severities(await lint(WEB_FILE, code), '@next/next/no-img-element'), [2]);
});

// ── Import alias (web only) ────────────────────────────────────────────────

test('a ../../ import inside apps/web/src is an error', async () => {
  const m = await lint(WEB_FILE, "export { cn } from '../../lib/cn';\n");
  assert.deepEqual(severities(m, 'no-restricted-imports'), [2]);
});

test('allows the @/ alias and a single ../ import', async () => {
  const m = await lint(
    WEB_FILE,
    "export { cn } from '@/lib/cn';\nexport { Button } from '../ui/Button';\n",
  );
  assert.deepEqual(severities(m, 'no-restricted-imports'), []);
});

test('does not apply the alias rule outside the web app', async () => {
  const m = await lint(PKG_FILE, "export { ok } from '../../src/result.js';\n");
  assert.deepEqual(severities(m, 'no-restricted-imports'), []);
});
