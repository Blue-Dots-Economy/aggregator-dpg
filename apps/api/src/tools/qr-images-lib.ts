/**
 * Pure helpers of the local QR image script (`scripts/qr-images.ts`): turn a
 * QR links report CSV into one PNG per loaded link. Runs on the operator's
 * machine, never in the pod. The report holds coordinator emails, so nothing
 * here logs row data.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { parseFile } from './org-loader-input.js';

/** Outcomes that have a link to draw. */
const DRAWN_OUTCOMES: ReadonlySet<string> = new Set(['created', 'already_loaded']);

/** Same options as the portal's QR dialog (`RegistrationLinksSection.tsx`). */
const QR_OPTIONS = { errorCorrectionLevel: 'M', margin: 1, width: 512 } as const;

/** Undoes the one quote `csvField` puts before a cell starting with `=`, `+`, `-`, `@`, TAB or CR. */
function unneutralise(cell: string): string {
  return /^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell;
}

/**
 * The image file name: `<email local part>-<profile_type>-<slug>.png`,
 * lowercase, every character outside `[a-z0-9-]` replaced with `-`.
 */
export function qrFileName(row: {
  coordinatorEmail: string;
  profileType: string;
  slug: string;
}): string {
  const local = row.coordinatorEmail.split('@')[0] ?? '';
  const stem = `${local}-${row.profileType}-${row.slug}`.toLowerCase();
  return `${stem.replaceAll(/[^a-z0-9-]/g, '-')}.png`;
}

/**
 * Writes one PNG per `created` or `already_loaded` row of the report.
 *
 * @param csvText - The `apply` report CSV.
 * @param outDir - Directory for the images; created when missing.
 * @returns How many images were written and how many rows were skipped.
 * @throws {Error} When a loaded row has no url, or a file cannot be written.
 */
export async function renderQrImages(
  csvText: string,
  outDir: string,
): Promise<{ written: number; skipped: number }> {
  const { records } = parseFile(csvText);
  await mkdir(outDir, { recursive: true });
  let written = 0;
  let skipped = 0;
  for (const { line, cells } of records) {
    const outcome = cells['outcome'] ?? '';
    if (!DRAWN_OUTCOMES.has(outcome)) {
      skipped += 1;
      continue;
    }
    const url = cells['url'];
    if (!url) throw new Error(`line ${line}: a ${outcome} row has no url`);
    const name = qrFileName({
      coordinatorEmail: unneutralise(cells['coordinator_email'] ?? ''),
      profileType: cells['profile_type'] ?? '',
      slug: unneutralise(cells['slug'] ?? ''),
    });
    await writeFile(join(outDir, name), await QRCode.toBuffer(url, QR_OPTIONS));
    written += 1;
  }
  return { written, skipped };
}
