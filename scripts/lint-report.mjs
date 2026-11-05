/**
 * Lint report for the repo root (`aggregator-dpg`): lints every workspace's
 * sources and prints message counts per rule and workspace, so each step of
 * the lint ratchet can show its before and after.
 *
 * Usage: `pnpm lint:report`. Exits 0 even when there are errors; `pnpm lint`
 * is the gate.
 */
import { relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

/**
 * Returns the workspace a file belongs to, e.g. `apps/web`, or `root`.
 *
 * @param filePath - Absolute path of a linted file.
 * @param root - Absolute path of the repo root.
 */
export function blockOf(filePath, root) {
  const [group, name] = relative(root, filePath).split('/');
  return (group === 'apps' || group === 'packages') && name ? `${group}/${name}` : 'root';
}

/**
 * Counts lint messages per rule and workspace.
 *
 * @param results - ESLint results (`filePath`, `messages[].ruleId`, `messages[].severity`).
 * @param root - Absolute path of the repo root.
 * @returns Rows sorted by rule, then workspace. A message with no rule is a parse error.
 */
export function summarize(results, root) {
  const rows = new Map();
  for (const result of results) {
    const workspace = blockOf(result.filePath, root);
    for (const message of result.messages) {
      const rule = message.ruleId ?? '(parse error)';
      const key = `${rule}\0${workspace}`;
      const row = rows.get(key) ?? { rule, workspace, warnings: 0, errors: 0 };
      if (message.severity === 2) row.errors += 1;
      else row.warnings += 1;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) => a.rule.localeCompare(b.rule, 'en') || a.workspace.localeCompare(b.workspace, 'en'),
  );
}

/**
 * Formats summary rows as an aligned text table with a total line.
 *
 * @param rows - Output of {@link summarize}.
 */
export function formatReport(rows) {
  if (rows.length === 0) return 'No lint messages.\n';
  const header = ['rule', 'workspace', 'warnings', 'errors'];
  const body = rows.map((r) => [r.rule, r.workspace, String(r.warnings), String(r.errors)]);
  const total = [
    'total',
    '',
    String(rows.reduce((n, r) => n + r.warnings, 0)),
    String(rows.reduce((n, r) => n + r.errors, 0)),
  ];
  const table = [header, ...body, total];
  const widths = header.map((_, i) => Math.max(...table.map((row) => row[i].length)));
  return `${table
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')}\n`;
}

/** Folders `main` lints: every workspace, the same files `pnpm lint` covers. */
export const LINT_TARGETS = ['apps', 'packages'];

async function main() {
  const root = join(import.meta.dirname, '..');
  const eslint = new ESLint({ cwd: root });
  const results = await eslint.lintFiles(LINT_TARGETS);
  process.stdout.write(formatReport(summarize(results, root)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
