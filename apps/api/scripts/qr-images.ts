/**
 * Writes one QR image (PNG) per loaded link of a QR links report (api app script).
 *
 * Runs on the operator's machine from a checkout (the api image has no tsx);
 * see `docs/qr-links-runbook.md`:
 *
 *   pnpm --filter @aggregator-dpg/api exec tsx scripts/qr-images.ts --in links-report.csv --out qr-images
 *
 * Reads the report the `apply` command wrote (`created` and `already_loaded`
 * rows only). Refuses an `--out` directory that already holds files, unless
 * `--force` is given. Prints counts only; the report holds coordinator emails.
 * Exits 1 on any failure, 2 on a usage error.
 */
import { readdir, readFile } from 'node:fs/promises';
import { renderQrImages } from '../src/tools/qr-images-lib.js';

const USAGE = 'usage: qr-images.ts --in <report.csv> --out <dir> [--force]';

/** Whether `dir` exists and holds anything. */
async function isNonEmpty(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return false;
    throw err;
  }
}

async function main(argv: string[]): Promise<number> {
  const flags = new Map<string, string>();
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--force') force = true;
    else if ((arg === '--in' || arg === '--out') && argv[i + 1] && !argv[i + 1]?.startsWith('--')) {
      flags.set(arg, argv[(i += 1)] ?? '');
    } else {
      process.stderr.write(`usage error: unexpected ${arg}\n${USAGE}\n`);
      return 2;
    }
  }
  const input = flags.get('--in');
  const out = flags.get('--out');
  if (!input || !out) {
    process.stderr.write(`usage error: --in and --out are required\n${USAGE}\n`);
    return 2;
  }
  if (!force && (await isNonEmpty(out))) {
    process.stderr.write(`REFUSED: ${out} is not empty; use a new directory or --force\n`);
    return 1;
  }
  const result = await renderQrImages(await readFile(input, 'utf8'), out);
  process.stderr.write(`wrote ${result.written} image(s), skipped ${result.skipped} row(s)\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
