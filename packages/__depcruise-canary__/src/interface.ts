/**
 * Canary fixture for the no-heavy-deps-in-interface dep-cruiser rule.
 *
 * This file intentionally imports `pg` — a package that violates the rule.
 * dep-cruiser must detect this import and report an error. CI verifies that
 * running dep-cruiser on this folder produces a violation (exit code 1).
 * If dep-cruiser exits 0 here, the rule is broken and CI fails.
 *
 * DO NOT remove the pg import or fix this file — it is supposed to be wrong.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pg is not installed; this file is only analysed by dep-cruiser, not compiled
import type { Client } from 'pg';

export type CanaryClient = Client;
