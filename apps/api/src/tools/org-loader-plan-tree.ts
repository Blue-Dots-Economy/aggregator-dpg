/**
 * Tree ordering and tree-limit checks for the org structure loader, in `@aggregator-dpg/api`.
 *
 * Pure functions over the org rows of one load: parents-first order, the rows
 * caught in a parent cycle, and the rows the instance's tree limits refuse
 * once the whole file is applied.
 */

import type { TreeRules } from '../services/organisation-store/interface.js';

/** Where an org row's parent is. `planned` is another row of the file, by lowercased name. */
export type TreeParent =
  | { kind: 'root' }
  | { kind: 'existing'; orgId: string; depth: number }
  | { kind: 'planned'; key: string };

/** One org row of the file, as the tree checks see it. */
export interface TreeNode {
  /** Lowercased, trimmed org name; unique among the nodes. */
  key: string;
  parent: TreeParent;
  /** The org's row when it already exists (resumed or already loaded); `null` for a new org. */
  existing: { orgId: string; depth: number } | null;
}

/** The existing tree the limits are checked against. */
export interface ExistingTree {
  rootId: string;
  /** Counted children per existing parent id (root included). */
  childCounts: ReadonlyMap<string, number>;
  /** Counted aggregator orgs. */
  total: number;
}

/** Which tree limit a new org breaks. */
export type TreeLimit = 'depth' | 'children' | 'total';

/**
 * Orders the nodes parents first, keeping file order where the tree allows.
 *
 * @param nodes - The nodes, in file order.
 * @returns The ordered keys, and the keys of every node on a parent cycle.
 *   A node below a cycle is in neither list.
 */
export function orderParentsFirst(nodes: readonly TreeNode[]): {
  order: string[];
  cycle: Set<string>;
} {
  const order = placeParentsFirst(nodes);
  return { order, cycle: findCycles(nodes, new Set(order)) };
}

/** Keys of the nodes whose parents can all be placed, parents first, in file order where the tree allows. */
function placeParentsFirst(nodes: readonly TreeNode[]): string[] {
  const placed = new Set<string>();
  const order: string[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const n of nodes) {
      if (placed.has(n.key)) continue;
      if (n.parent.kind === 'planned' && !placed.has(n.parent.key)) continue;
      placed.add(n.key);
      order.push(n.key);
      progress = true;
    }
  }
  return order;
}

/** Keys of the unplaced nodes that sit on a parent cycle. */
function findCycles(nodes: readonly TreeNode[], placed: ReadonlySet<string>): Set<string> {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const cycle = new Set<string>();
  for (const start of nodes) {
    if (placed.has(start.key) || cycle.has(start.key)) continue;
    const path: string[] = [];
    let cur: TreeNode | undefined = start;
    while (cur && !path.includes(cur.key) && !cycle.has(cur.key) && !placed.has(cur.key)) {
      path.push(cur.key);
      cur = cur.parent.kind === 'planned' ? byKey.get(cur.parent.key) : undefined;
    }
    if (cur && path.includes(cur.key)) {
      for (const key of path.slice(path.indexOf(cur.key))) cycle.add(key);
    }
  }
  return cycle;
}

/**
 * Finds the new orgs the tree limits refuse once every node is applied.
 *
 * Existing nodes are not checked but count toward their parent's children
 * through `tree.childCounts`. Children and total limits refuse the rows past
 * the limit, in the given order.
 *
 * @param ordered - The nodes, parents first.
 * @param rules - The instance's tree limits.
 * @param tree - Counts of the existing tree.
 * @returns The refused new nodes' keys and the limit each breaks.
 */
export function treeLimitRefusals(
  ordered: readonly TreeNode[],
  rules: TreeRules,
  tree: ExistingTree,
): Map<string, TreeLimit> {
  const depthOf = new Map<string, number>();
  const children = new Map<string, number>(tree.childCounts);
  const refused = new Map<string, TreeLimit>();
  let total = tree.total;
  for (const n of ordered) {
    const parentDepth = depthOfParent(n.parent, depthOf);
    depthOf.set(n.key, n.existing?.depth ?? parentDepth + 1);
    if (n.existing) continue;
    const parentId = parentSlot(n.parent, ordered, tree.rootId);
    const count = children.get(parentId) ?? 0;
    if (parentDepth + 1 > rules.maxDepth) refused.set(n.key, 'depth');
    else if (rules.maxChildren !== null && count >= rules.maxChildren) {
      refused.set(n.key, 'children');
    } else if (total >= rules.maxTotalOrgs) refused.set(n.key, 'total');
    if (refused.has(n.key)) continue;
    children.set(parentId, count + 1);
    total += 1;
  }
  return refused;
}

/** The parent's depth: 0 for the root. */
function depthOfParent(parent: TreeParent, depthOf: ReadonlyMap<string, number>): number {
  if (parent.kind === 'root') return 0;
  if (parent.kind === 'existing') return parent.depth;
  return depthOf.get(parent.key) ?? 0;
}

/** The key that counts the parent's children: its org id, or its row key while it is new. */
function parentSlot(parent: TreeParent, nodes: readonly TreeNode[], rootId: string): string {
  if (parent.kind === 'root') return rootId;
  if (parent.kind === 'existing') return parent.orgId;
  const node = nodes.find((n) => n.key === parent.key);
  return node?.existing?.orgId ?? `planned:${parent.key}`;
}
