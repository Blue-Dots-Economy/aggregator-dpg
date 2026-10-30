/**
 * Tree checks shared by the organisation stores (`@aggregator-dpg/api`).
 *
 * Pure functions over a snapshot of the org tree. Both stores call them under
 * their tree lock, so the memory and Postgres stores refuse the same writes
 * with the same codes.
 */

import type { OrgStoreError, TreeRules } from './interface.js';

/** One org in a tree snapshot; the root included. */
export interface TreeNode {
  id: string;
  parentId: string | null;
  depth: number;
  status: string;
  isRoot: boolean;
  isDefault: boolean;
  knownAs: string;
}

/** A tree snapshot indexed by id and by parent. */
export interface Tree {
  byId: Map<string, TreeNode>;
  children: Map<string, TreeNode[]>;
}

/** The codes a create, revival or move can be refused with. */
export type TreeRefusal = Extract<
  OrgStoreError['code'],
  | 'NOT_FOUND'
  | 'INVALID_PARENT'
  | 'DEPTH_LIMIT'
  | 'CHILD_LIMIT'
  | 'TOTAL_LIMIT'
  | 'PARENT_CYCLE'
  | 'NOT_MOVABLE'
>;

/** Levels the read walks (`descendantIds`, search below an org) go down at most. */
export const DESCENDANT_LEVEL_CAP = 32;

/**
 * Whether an org counts toward the limits: pending or active, not the Default org.
 *
 * @param n - The org.
 * @returns True when it counts.
 */
export function counts(n: Pick<TreeNode, 'status' | 'isDefault'>): boolean {
  return (n.status === 'pending' || n.status === 'active') && !n.isDefault;
}

/**
 * Whether an org may take a child: the root, or an active org that is not the Default org.
 *
 * @param n - The org.
 * @returns True when it may be a parent.
 */
export function canParent(n: TreeNode): boolean {
  return n.isRoot || (n.status === 'active' && !n.isDefault);
}

/**
 * Checks the limits for one new org under a valid parent.
 *
 * @param parentDepth - The parent's depth.
 * @param childCount - The parent's counted children, the new org excluded.
 * @param total - Counted aggregator orgs, the new org excluded.
 * @param rules - Tree limits.
 * @returns The refusal code, or `null` when the org fits.
 */
export function newChildRefusal(
  parentDepth: number,
  childCount: number,
  total: number,
  rules: TreeRules,
): 'DEPTH_LIMIT' | 'CHILD_LIMIT' | 'TOTAL_LIMIT' | null {
  if (parentDepth + 1 > rules.maxDepth) return 'DEPTH_LIMIT';
  if (rules.maxChildren !== null && childCount >= rules.maxChildren) return 'CHILD_LIMIT';
  if (total >= rules.maxTotalOrgs) return 'TOTAL_LIMIT';
  return null;
}

/**
 * Indexes a tree snapshot.
 *
 * @param nodes - Every org, the root included.
 * @returns The snapshot indexed by id and by parent.
 */
export function buildTree(nodes: readonly TreeNode[]): Tree {
  const byId = new Map<string, TreeNode>();
  const children = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (n.parentId === null) continue;
    const list = children.get(n.parentId);
    if (list) list.push(n);
    else children.set(n.parentId, [n]);
  }
  return { byId, children };
}

/**
 * Lists an org and every org below it, any status.
 *
 * @param tree - The snapshot.
 * @param id - The top org.
 * @param maxLevels - Levels below the org to walk; every level when omitted.
 * @returns The org first, then its descendants.
 */
export function subtree(tree: Tree, id: string, maxLevels = Infinity): TreeNode[] {
  const top = tree.byId.get(id);
  if (!top) return [];
  const seen = new Set([id]);
  const out = [top];
  let frontier = [top];
  for (let level = 0; level < maxLevels && frontier.length > 0; level++) {
    const next: TreeNode[] = [];
    for (const n of frontier) {
      for (const c of tree.children.get(n.id) ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
        next.push(c);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Checks a move of `id` under `parentId`, ignoring "known as" values.
 *
 * Moving to the current parent is allowed whenever the org itself may move.
 *
 * @param tree - The snapshot.
 * @param id - The org to move.
 * @param parentId - The new parent.
 * @param rules - Tree limits.
 * @returns The refusal code, or `null` when the move is allowed.
 */
export function moveRefusal(
  tree: Tree,
  id: string,
  parentId: string,
  rules: TreeRules,
): TreeRefusal | null {
  const org = tree.byId.get(id);
  if (!org) return 'NOT_FOUND';
  if (org.isRoot || !counts(org)) return 'NOT_MOVABLE';
  if (org.parentId === parentId) return null;
  const parent = tree.byId.get(parentId);
  if (!parent || !canParent(parent)) return 'INVALID_PARENT';
  const moved = subtree(tree, id);
  if (moved.some((n) => n.id === parentId)) return 'PARENT_CYCLE';
  const siblings = (tree.children.get(parentId) ?? []).filter(counts).length;
  if (rules.maxChildren !== null && siblings >= rules.maxChildren) return 'CHILD_LIMIT';
  const height = Math.max(...moved.map((n) => n.depth)) - org.depth;
  if (parent.depth + 1 + height > rules.maxDepth) return 'DEPTH_LIMIT';
  return null;
}

/**
 * Checks `parentId` as a move option for `id`: the move checks, then the "known as" values below.
 *
 * The moved org's own value is not checked, because the move can give it a new one.
 *
 * @param tree - The snapshot.
 * @param id - The org to move.
 * @param parentId - The candidate parent.
 * @param rules - Tree limits and "known as" rules.
 * @returns The refusal code, `KNOWN_AS_DEPTH` when an org below would sit at a depth its
 *   value does not allow, or `null` when the option is allowed.
 */
/**
 * Whether an org below a moved org blocks the move with its "known as" value.
 *
 * A value the instance no longer configures does not block: the move does not
 * make it less valid, and the boot check reports it. A configured value must
 * be allowed at the org's new depth.
 *
 * @param rules - The tree rules.
 * @param key - The org's "known as" key.
 * @param depth - The org's depth after the move.
 * @returns True when the move must be refused.
 */
export function knownAsBlocksMove(rules: TreeRules, key: string, depth: number): boolean {
  return rules.knownAsConfigured(key) && !rules.knownAsAllowed(key, depth);
}

export function parentOptionRefusal(
  tree: Tree,
  id: string,
  parentId: string,
  rules: TreeRules,
): TreeRefusal | 'KNOWN_AS_DEPTH' | null {
  const refused = moveRefusal(tree, id, parentId, rules);
  if (refused) return refused;
  const org = tree.byId.get(id)!;
  if (org.parentId === parentId) return null;
  const delta = tree.byId.get(parentId)!.depth + 1 - org.depth;
  const below = subtree(tree, id).slice(1);
  return below.some((n) => knownAsBlocksMove(rules, n.knownAs, n.depth + delta))
    ? 'KNOWN_AS_DEPTH'
    : null;
}
