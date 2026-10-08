/**
 * Pure logic of the instance-upgrade operator tool (`@aggregator-dpg/api`,
 * `tools/train.ts`): where a database stands relative to the train. The tool
 * takes 0022 — or a database part-way through the train, such as a rehearsal
 * copy migrated by an earlier release — to the latest shipped migration; any
 * other level is refused (design: docs/plans/user-org-migrate-tool-simplification.md).
 */

import { PRE_TRAIN_WHEN, type AppliedMigration, type JournalEntry } from '../db/migrate-core.js';

/**
 * `start`: exactly 0022, the train is pending. `partial`: at a shipped
 * migration after 0022, short of the latest. `done`: at the latest shipped
 * migration. `fresh`: nothing applied (boot migrates a fresh database).
 * `other`: below 0022, or a level this release does not ship — refused.
 */
export type UpgradeState = 'start' | 'partial' | 'done' | 'fresh' | 'other';

/** The applied level and what is pending. */
export interface UpgradeLevel {
  state: UpgradeState;
  /** Tag of the highest applied migration, or `null` (none, or not shipped). */
  appliedTag: string | null;
  /** Tags of the shipped migrations above the applied high-water mark. */
  pending: string[];
}

/**
 * Classifies the applied migrations against the shipped journal.
 *
 * @param journal - Shipped entries, in order.
 * @param applied - Applied rows (`null` / empty when nothing is applied).
 * @returns The state, the applied tag and the pending tags.
 */
export function upgradeLevel(
  journal: readonly JournalEntry[],
  applied: readonly AppliedMigration[] | null,
): UpgradeLevel {
  if (!applied || applied.length === 0) {
    return { state: 'fresh', appliedTag: null, pending: journal.map((e) => e.tag) };
  }
  const highWater = Math.max(...applied.map((a) => a.createdAt));
  const appliedTag = journal.find((e) => e.when === highWater)?.tag ?? null;
  const pending = journal.filter((e) => e.when > highWater).map((e) => e.tag);
  const latest = journal.at(-1)?.when;
  let state: UpgradeState = 'other';
  if (highWater === PRE_TRAIN_WHEN) state = 'start';
  else if (highWater === latest) state = 'done';
  else if (appliedTag !== null && highWater > PRE_TRAIN_WHEN) state = 'partial';
  return { state, appliedTag, pending };
}
