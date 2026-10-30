/**
 * Organisation choices for console filters (`apps/web`): the organisations a
 * viewer can reach, in tree order, each labelled with its path and "known as"
 * value, e.g. "Karnataka › Mysuru (District)". Also the "known as" values
 * allowed at a depth.
 *
 * @module apps/web/src/lib/console-org-options
 */

import type {
  OrgHierarchyResponse,
  OrgSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';

type OrgRow = OrgSearchResponse['orgs'][number];

/** A selectable "known as" value. */
export interface KnownAsChoice {
  key: string;
  name: string;
}

/**
 * The "known as" values allowed at a depth: the system value, values with no
 * depth limit, and values that list the depth. Config order is kept.
 *
 * @param values - The configured values, from `GET /v1/org/hierarchy`.
 * @param depth - The org's depth (1 for a top-level org).
 * @returns The allowed values.
 */
export function knownAsChoicesAt(
  values: OrgHierarchyResponse['known_as']['values'],
  depth: number,
): KnownAsChoice[] {
  return values
    .filter((v) => v.system || v.depths === null || v.depths.includes(depth))
    .map((v) => ({ key: v.key, name: v.name }));
}

/** One choice in an organisation filter. */
export interface OrgOption {
  id: string;
  /** The org's own name. */
  name: string;
  /** Path from the topmost listed ancestor, with the "known as" name. */
  label: string;
}

/**
 * Orders orgs as their tree (parents before children, siblings by name) and
 * labels each with its path.
 *
 * An org whose parent is not in the list starts a path of its own, so every
 * org appears once.
 *
 * @param orgs - The reachable orgs, in any order.
 * @returns The options in tree order.
 */
export function orgOptionsInTreeOrder(orgs: readonly OrgRow[]): OrgOption[] {
  const ids = new Set(orgs.map((o) => o.id));
  const byParent = new Map<string | null, OrgRow[]>();
  for (const o of orgs) {
    const parent = o.parent_id && ids.has(o.parent_id) ? o.parent_id : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), o]);
  }
  const out: OrgOption[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, path: string[]) => {
    const kids = [...(byParent.get(parent) ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    for (const o of kids) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      const names = [...path, o.name];
      const knownAs = o.known_as_name ?? o.known_as;
      out.push({
        id: o.id,
        name: o.name,
        label: `${names.join(' › ')}${knownAs ? ` (${knownAs})` : ''}`,
      });
      walk(o.id, names);
    }
  };
  walk(null, []);
  return out;
}

/**
 * The orgs below one org, at any depth, from a flat list.
 *
 * @param rootId - The org to look below.
 * @param orgs - Orgs with their `parent_id`, in any order.
 * @returns The descendants, the root itself excluded.
 */
export function orgsBelow(rootId: string, orgs: readonly OrgRow[]): OrgRow[] {
  const below = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of orgs) {
      if (o.parent_id && below.has(o.parent_id) && !below.has(o.id)) {
        below.add(o.id);
        grew = true;
      }
    }
  }
  return orgs.filter((o) => o.id !== rootId && below.has(o.id));
}

/**
 * The owned orgs that sit under no other owned org: the roots of an owner's trees.
 *
 * @param ownedIds - The orgs the viewer owns.
 * @param orgs - The orgs the viewer reaches, with their `parent_id`.
 * @returns The topmost owned orgs, by name.
 */
export function topmostOwned(ownedIds: readonly string[], orgs: readonly OrgRow[]): OrgRow[] {
  const owned = orgs.filter((o) => ownedIds.includes(o.id));
  const nested = new Set(owned.flatMap((o) => orgsBelow(o.id, orgs).map((d) => d.id)));
  return owned
    .filter((o) => !nested.has(o.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
