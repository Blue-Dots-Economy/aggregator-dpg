/**
 * QR links loader operator command (`@aggregator-dpg/api`). Creates live
 * two-option registration links for coordinators from a links sheet. Shipped
 * in the API image and run in the API pod through `kubectl exec -i`:
 *
 *   node dist/tools/qr-links.js check --links - < links.csv
 *   node dist/tools/qr-links.js apply --links - --operator <name> < links.csv > report.csv
 *
 * The commands live in `qr-links-command.ts`. This entry sends log lines to
 * stderr before the API config loads, so stdout carries only the report.
 * Exit codes: 0 ok, 1 refused or failed, 2 usage.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Whether this module is the process entry, including through a symlink. */
function isEntry(): boolean {
  try {
    return pathToFileURL(realpathSync(process.argv[1] ?? '')).href === import.meta.url;
  } catch {
    // No path (e.g. `node -e`): not the entry.
    return false;
  }
}

if (isEntry()) {
  // Read by the API config at import, so it is set before the commands load.
  // Always stderr: the pod's env may say `stdout`, which would mix log lines into the report.
  process.env.LOG_DESTINATION = 'stderr';
  const { run } = await import('./qr-links-command.js');
  process.exitCode = await run(process.argv.slice(2));
}
