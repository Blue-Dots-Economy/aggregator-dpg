/**
 * Boot-time check of the organisation tree against its config (`@aggregator-dpg/api`).
 *
 * Existing orgs may sit outside the limits after a config change. They stay as
 * they are; only new creates and moves are checked. This logs one entry per
 * kind of excess, with counts only, so an operator can see it. More orgs than
 * `max_total_orgs` is logged as an error, because it closes self-registration
 * of new orgs. It never stops boot.
 *
 * It also counts orgs whose `known_as` key is neither in their parent's list
 * nor `aggregator`. Such keys read as "Aggregator" until someone sets them,
 * and it warns when the config still has an `organisation.known_as` block,
 * which the API ignores.
 */

import type { OrganisationConfig } from '@aggregator-dpg/network-config/interface';
import type { KnownAsValues } from '@aggregator-dpg/shared-primitives/user-org';
import { knownAsKeyValid } from './known-as.js';
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
 * `known_as` key is neither in the parent's list nor `aggregator`. Counts
 * pending and active orgs only, the Default org excluded. A total over the
 * limit, and a failure of the check, are logged as errors; a failure ends the
 * check and never throws. Also warns when `cfg` has a `known_as` block.
 *
 * @param store - The organisation store.
 * @param cfg - The instance's `organisation` config.
 * @param log - Logger.
 */
export async function warnOrgTreeOverLimits(
  store: OrganisationStoreBase,
  cfg: OrganisationConfig,
  log: { warn(obj: object): void; error(obj: object): void },
): Promise<void> {
  const { max_depth, max_children, max_total_orgs } = cfg.hierarchy;
  const warn = (check: string, fields: object) =>
    log.warn({ operation: OPERATION, status: 'success', check, ...fields });
  if (cfg.known_as !== undefined) {
    log.warn({
      operation: OPERATION,
      status: 'skipped',
      check: 'known_as_config',
      detail:
        'organisation.known_as in the instance config is ignored; owners set "known as" values in the console',
    });
  }
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
      // New orgs cannot register until the limit is raised.
      log.error({
        operation: OPERATION,
        status: 'success',
        check: 'total',
        total_orgs: orgs.length,
        max_total_orgs,
        registration: 'closed',
      });
    } else if (orgs.length === max_total_orgs) {
      warn('total', { total_orgs: orgs.length, max_total_orgs, registration: 'closed' });
    }

    const stale = await countStaleKnownAs(store, orgs);
    if (stale > 0) warn('known_as', { org_count: stale });
  } catch (e) {
    log.error({
      operation: OPERATION,
      status: 'failure',
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Counts orgs whose `known_as` key is neither in the parent's list nor `aggregator`.
 *
 * Parents outside `orgs` (the root, an inactive org) are read one by one.
 *
 * @param store - The organisation store.
 * @param orgs - The orgs to check, the Default org excluded.
 * @returns The count.
 * @throws {Error} When a store read fails.
 */
async function countStaleKnownAs(
  store: OrganisationStoreBase,
  orgs: Organisation[],
): Promise<number> {
  const lists = new Map<string, KnownAsValues>(orgs.map((o) => [o.id, o.knownAsValues]));
  const root = valueOf(await store.findRoot());
  if (root) lists.set(root.id, root.knownAsValues);
  let stale = 0;
  for (const o of orgs) {
    if (o.parentId === null) continue;
    let list = lists.get(o.parentId);
    if (list === undefined) {
      list = valueOf(await store.findById(o.parentId))?.knownAsValues ?? [];
      lists.set(o.parentId, list);
    }
    if (!knownAsKeyValid(list, o.knownAs)) stale += 1;
  }
  return stale;
}
