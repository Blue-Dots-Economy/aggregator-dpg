import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockOf, summarize, formatReport } from './lint-report.mjs';

const root = '/repo';

test('blockOf maps a file to its workspace', () => {
  assert.equal(blockOf('/repo/apps/web/src/a.tsx', root), 'apps/web');
  assert.equal(blockOf('/repo/packages/rbac/src/x/y.ts', root), 'packages/rbac');
  assert.equal(blockOf('/repo/scripts/stack.mjs', root), 'root');
});

test('summarize counts messages per rule and workspace, split by severity', () => {
  const results = [
    {
      filePath: '/repo/apps/api/src/a.ts',
      messages: [
        { ruleId: 'eqeqeq', severity: 1 },
        { ruleId: '@typescript-eslint/consistent-type-assertions', severity: 1 },
        { ruleId: '@typescript-eslint/consistent-type-assertions', severity: 1 },
      ],
    },
    {
      filePath: '/repo/apps/web/src/b.tsx',
      messages: [
        { ruleId: 'react-hooks/rules-of-hooks', severity: 2 },
        { ruleId: null, severity: 2 },
      ],
    },
    { filePath: '/repo/packages/rbac/src/c.ts', messages: [] },
  ];
  assert.deepEqual(summarize(results, root), [
    { rule: '(parse error)', workspace: 'apps/web', warnings: 0, errors: 1 },
    {
      rule: '@typescript-eslint/consistent-type-assertions',
      workspace: 'apps/api',
      warnings: 2,
      errors: 0,
    },
    { rule: 'eqeqeq', workspace: 'apps/api', warnings: 1, errors: 0 },
    { rule: 'react-hooks/rules-of-hooks', workspace: 'apps/web', warnings: 0, errors: 1 },
  ]);
});

test('formatReport prints one row per entry and a total line', () => {
  const text = formatReport([
    { rule: 'eqeqeq', workspace: 'apps/api', warnings: 3, errors: 0 },
    { rule: 'import-x/no-cycle', workspace: 'apps/worker', warnings: 0, errors: 1 },
  ]);
  const lines = text.trim().split('\n');
  assert.match(lines[0], /rule\s+workspace\s+warnings\s+errors/);
  assert.match(lines[1], /eqeqeq\s+apps\/api\s+3\s+0/);
  assert.match(lines[2], /import-x\/no-cycle\s+apps\/worker\s+0\s+1/);
  assert.match(lines.at(-1), /total\s+3\s+1/);
});

test('formatReport says so when there is nothing to report', () => {
  assert.match(formatReport([]), /No lint messages/);
});
