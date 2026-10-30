/**
 * Boot-time check of the organisation tree against its config (`@aggregator-dpg/api`).
 *
 * Existing orgs may sit outside the limits after a config change. They stay as
 * they are; only new creates and moves are checked. This logs one warning per
 * kind of excess, with counts only, so an operator can see it. It never stops boot.
 */

import type { OrganisationConfig } from '@aggregator-dpg/network-config/interface';
import { isAllowedAt } from './known-as.js';
import type {
  Organisation,
  OrganisationStoreBase,
  OrgCursor,
  OrgStoreResult,
  SearchOrgsPage,
} from './organisation-store/interface.js';

const OPERATION = 'orgTree.bootCheck';

/** The value of a store result; throws on a failure, which ends the check. */
function valueOf<T>(r: OrgStoreResult<T>): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Every pending and active aggregator org, the Default org included, read page by page. */
async function countedOrgs(store: OrganisationStoreBase): Promise<Organisation[]> {
  const rows: Organisation[] = [];
  for (const status of ['pending', 'active'] as const) {
    let cursor: OrgCursor | null = null;
    do {
      const page: SearchOrgsPage = valueOf(
        await store.search({ orgIds: null, status, limit: 100, ...(cursor ? { cursor } : {}) }),
      );
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor);
  }
  return rows;
}

/**
 * Logs a warning for each kind of org that is outside the tree config.
 *
 * Kinds: orgs deeper than `max_depth`; orgs (the root included) with more
 * children than `max_children`; more orgs than `max_total_orgs`; orgs whose
 * `known_as` key is not configured or not allowed at their depth. Counts
 * pending and active orgs only, the Default org excluded. A failure is logged and ends the check; it never throws.
 *
 * @param store - The organisation store.
 * @param cfg - The instance's `organisation` config.
 * @param log - Logger; only `warn` is used.
 */
export async function warnOrgTreeOverLimits(
  store: OrganisationStoreBase,
  cfg: OrganisationConfig,
  log: { warn(obj: object): void },
): Promise<void> {
  const { max_depth, max_children, max_total_orgs } = cfg.hierarchy;
  const warn = (check: string, fields: object) =>
    log.warn({ operation: OPERATION, status: 'success', check, ...fields });
  try {
    const orgs = (await countedOrgs(store)).filter((o) => !o.isDefault);

    const deep = orgs.filter((o) => o.depth > max_depth).length;
    if (deep > 0) warn('depth', { org_count: deep, max_depth });

    if (max_children !== undefined) {
      const children = new Map<string | null, number>();
      for (const o of orgs) children.set(o.parentId, (children.get(o.parentId) ?? 0) + 1);
      const full = [...children.values()].filter((n) => n > max_children).length;
      if (full > 0) warn('children', { org_count: full, max_children });
    }

    if (orgs.length > max_total_orgs) {
      warn('total', { total_orgs: orgs.length, max_total_orgs });
    }

    const stale = orgs.filter((o) => !isAllowedAt(cfg.known_as, o.knownAs, o.depth)).length;
    if (stale > 0) warn('known_as', { org_count: stale });
  } catch (e) {
    log.warn({
      operation: OPERATION,
      status: 'failure',
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
