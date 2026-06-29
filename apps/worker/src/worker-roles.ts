/**
 * Worker-role selection for the BullMQ worker process.
 *
 * By default one process runs every queue consumer. Setting `WORKER_ROLES`
 * lets a deployment run a subset — most usefully the CPU-sensitive File
 * Processor (`file`) in its own pod, so a large parse cannot contend with the
 * row / finalise / cron consumers on the same event loop, and each role scales
 * independently.
 *
 * @module @aggregator-dpg/worker
 */

/** Selectable consumer roles. `cron` covers link-metrics + watchdog ticks. */
export const WORKER_ROLES = ['file', 'row', 'finalise', 'cron'] as const;

/** A single worker role. */
export type WorkerRole = (typeof WORKER_ROLES)[number];

const ALL_ROLES: ReadonlySet<WorkerRole> = new Set(WORKER_ROLES);

/**
 * Parses the `WORKER_ROLES` env value into the set of roles this process runs.
 *
 * Unset, empty, or the literal `all` selects every role (backwards-compatible
 * single-process default). Otherwise the value is a comma-separated list;
 * tokens are case- and whitespace-insensitive and empty tokens are ignored.
 *
 * @param value - Raw `WORKER_ROLES` env value, if set.
 * @returns The set of roles to start. Always non-empty.
 * @throws {Error} If any token is not a known role — fail fast at boot rather
 *   than silently running fewer consumers than intended.
 */
export function parseWorkerRoles(value?: string): Set<WorkerRole> {
  const raw = (value ?? '').trim();
  if (raw === '' || raw.toLowerCase() === 'all') {
    return new Set(WORKER_ROLES);
  }
  const roles = new Set<WorkerRole>();
  for (const token of raw.split(',')) {
    const role = token.trim().toLowerCase();
    if (role === '') continue;
    if (!ALL_ROLES.has(role as WorkerRole)) {
      throw new Error(`Unknown worker role: "${role}". Valid roles: ${WORKER_ROLES.join(', ')}.`);
    }
    roles.add(role as WorkerRole);
  }
  return roles.size === 0 ? new Set(WORKER_ROLES) : roles;
}
