/**
 * Org structure loader operator command (`@aggregator-dpg/api`). Runbook:
 * docs/org-structure-loader-runbook.md. Shipped in the API image and run in
 * the API pod, which has the API's ConfigMap and Secret, through `kubectl exec -i`:
 *
 *   node dist/tools/org-loader.js template --kind orgs|coordinators
 *   node dist/tools/org-loader.js check --orgs - < orgs.csv
 *   node dist/tools/org-loader.js apply --orgs - --operator <name> < orgs.csv > report.csv
 *
 * The commands live in `org-loader-command.ts`. This entry sends log lines to
 * stderr before the API config loads, so stdout carries only the tool's output.
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
  const { run } = await import('./org-loader-command.js');
  process.exitCode = await run(process.argv.slice(2));
}
