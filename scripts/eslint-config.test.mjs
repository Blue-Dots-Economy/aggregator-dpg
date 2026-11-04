import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

let cycleDir;
before(() => {
  cycleDir = mkdtempSync(join(root, 'packages', 'shared-primitives', 'src', '.lint-cycle-'));
  writeFileSync(
    join(cycleDir, 'a.ts'),
    "import { b } from './b.js';\nexport const a = (): number => b() + 1;\n",
  );
  writeFileSync(
    join(cycleDir, 'b.ts'),
    "import { a } from './a.js';\nexport const b = (): number => (a() > 0 ? 1 : 0);\n",
  );
});
after(() => rmSync(cycleDir, { recursive: true, force: true }));

test('import-x/no-cycle reports a cycle between two TypeScript files', async () => {
  const [result] = await eslint.lintFiles([relative(root, join(cycleDir, 'a.ts'))]);
  assert.deepEqual(severities(result.messages, 'import-x/no-cycle'), [2]);
});

test('import-x/no-cycle ignores a type-only import back into the module', async () => {
  const [result] = await eslint.lintText(
    "import type { a } from './a.js';\nexport type B = typeof a;\n",
    { filePath: join(cycleDir, 'c.ts') },
  );
  assert.deepEqual(severities(result.messages, 'import-x/no-cycle'), []);
});

// ── eqeqeq ─────────────────────────────────────────────────────────────────

test('eqeqeq warns on == between values', async () => {
  const m = await lint(PKG_FILE, 'export const f = (a: number, b: number): boolean => a == b;\n');
  assert.deepEqual(severities(m, 'eqeqeq'), [1]);
});

test('eqeqeq allows == null', async () => {
  const m = await lint(PKG_FILE, 'export const f = (a: number | null): boolean => a == null;\n');
  assert.deepEqual(severities(m, 'eqeqeq'), []);
});

// ── @typescript-eslint/consistent-type-assertions ──────────────────────────

const CAST = 'interface Foo { x: number }\nexport const f = (v: unknown): Foo => v as Foo;\n';
const RULE_CAST = '@typescript-eslint/consistent-type-assertions';

test('warns on an `as` cast in production code', async () => {
  assert.deepEqual(severities(await lint(PKG_FILE, CAST), RULE_CAST), [1]);
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

test('react-hooks/set-state-in-effect warns on state copied in an effect', async () => {
  const code = `import { useEffect, useState } from 'react';
export function Probe({ items }: { items: string[] }) {
  const [visible, setVisible] = useState(items);
  useEffect(() => {
    setVisible(items.filter((i) => i !== ''));
  }, [items]);
  return <p>{visible.length}</p>;
}
`;
  assert.deepEqual(severities(await lint(WEB_FILE, code), 'react-hooks/set-state-in-effect'), [1]);
});

test('react-hooks/exhaustive-deps warns on a missing dependency', async () => {
  const code = `import { useEffect } from 'react';
export function Probe({ id }: { id: string }) {
  useEffect(() => {
    document.title = id;
  }, []);
  return null;
}
`;
  assert.deepEqual(severities(await lint(WEB_FILE, code), 'react-hooks/exhaustive-deps'), [1]);
});

// ── Next.js (web only) ─────────────────────────────────────────────────────

test('@next/next rules run in the web app as warnings', async () => {
  const code = 'export function Probe() {\n  return <img src="/x.png" alt="x" />;\n}\n';
  assert.deepEqual(severities(await lint(WEB_FILE, code), '@next/next/no-img-element'), [1]);
});

// ── Import alias (web only) ────────────────────────────────────────────────

test('warns on a ../../ import inside apps/web/src', async () => {
  const m = await lint(WEB_FILE, "export { cn } from '../../lib/cn';\n");
  assert.deepEqual(severities(m, 'no-restricted-imports'), [1]);
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
