import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

/** Workspaces with TypeScript sources: every `apps/*` and `packages/*` with a `src/` folder. */
function sourceWorkspaces() {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, group, d.name, 'src')))
      .map((d) => `${group}/${d.name}`),
  );
}

test('finds the workspaces to check', () => {
  const found = sourceWorkspaces();
  assert.ok(found.includes('apps/api'));
  assert.ok(found.includes('apps/worker'));
  assert.ok(found.includes('packages/shared-primitives'));
});

test('every workspace with sources has a lint script, so turbo lints it', () => {
  const missing = sourceWorkspaces().filter((ws) => {
    const pkg = JSON.parse(readFileSync(join(root, ws, 'package.json'), 'utf8'));
    return typeof pkg.scripts?.lint !== 'string';
  });
  assert.deepEqual(missing, []);
});

test('every workspace lints with the same command, so the shared config decides what is ignored', () => {
  const commands = new Set(
    sourceWorkspaces().map(
      (ws) => JSON.parse(readFileSync(join(root, ws, 'package.json'), 'utf8')).scripts.lint,
    ),
  );
  assert.deepEqual([...commands], ['eslint --no-warn-ignored .']);
});

test('the turbo lint cache depends on the shared ESLint config', () => {
  const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8'));
  assert.ok(turbo.tasks.lint.inputs?.includes('$TURBO_ROOT$/eslint.config.js'));
  assert.ok(turbo.tasks.lint.inputs?.includes('$TURBO_DEFAULT$'));
});
