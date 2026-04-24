#!/usr/bin/env tsx
/**
 * Local-dev seed script.
 *
 * Populates a deterministic sample dataset for manual testing and for
 * downstream services that need realistic foreign-key targets. Idempotent —
 * safe to re-run. Uses fixed UUIDs so referencing rows from fixtures or URLs
 * works across runs.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm --filter @aggregator-dpg/db seed
 *
 * @module @aggregator-dpg/db/scripts/seed
 */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/schema/index.js';

// Deterministic UUIDs so the seed stays idempotent and cross-run-stable.
const SEED_IDS = {
  schemaVersion: '00000000-0000-0000-0000-000000000001',
  aggregator: '00000000-0000-0000-0000-000000000002',
  onboardingLink1: '00000000-0000-0000-0000-000000000010',
  onboardingLink2: '00000000-0000-0000-0000-000000000011',
} as const;

type ConsoleLike = {
  log: (msg: string) => void;
  error: (msg: string) => void;
};

export interface SeedResult {
  schemaVersion: { id: string; inserted: boolean };
  aggregator: { aggregatorId: string; inserted: boolean };
  onboardingLinks: { id: string; inserted: boolean }[];
}

/**
 * Runs the seed workflow against the given Drizzle client. Separated from the
 * CLI wrapper so tests can drive it directly without spawning a subprocess.
 */
export async function runSeed(
  db: ReturnType<typeof drizzle<typeof schema>>,
  log: ConsoleLike = console,
): Promise<SeedResult> {
  // Schema version — active baseline for local aggregators to reference.
  const schemaRows = await db
    .insert(schema.aggregatorProfileSchema)
    .values({
      id: SEED_IDS.schemaVersion,
      version: '1',
      schemaJson: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { orgName: { type: 'string' } },
      },
      active: true,
    })
    .onConflictDoNothing({ target: schema.aggregatorProfileSchema.id })
    .returning();
  const schemaInserted = schemaRows.length > 0;

  // Sample aggregator on that schema version.
  const aggRows = await db
    .insert(schema.aggregatorProfile)
    .values({
      aggregatorId: SEED_IDS.aggregator,
      schemaVersion: SEED_IDS.schemaVersion,
      valuesJson: { orgName: 'Acme Aggregator (seed)' },
    })
    .onConflictDoNothing({ target: schema.aggregatorProfile.aggregatorId })
    .returning();
  const aggInserted = aggRows.length > 0;

  // Two demo onboarding links — one for seekers, one for providers.
  const linkInputs = [
    {
      id: SEED_IDS.onboardingLink1,
      aggregatorId: SEED_IDS.aggregator,
      mode: 'link' as const,
      targetRole: 'seeker' as const,
      label: 'Seed — Seeker Onboarding',
      joinCount: 0,
    },
    {
      id: SEED_IDS.onboardingLink2,
      aggregatorId: SEED_IDS.aggregator,
      mode: 'qr' as const,
      targetRole: 'provider' as const,
      label: 'Seed — Provider Onboarding',
      joinCount: 0,
    },
  ];

  const linkResults: SeedResult['onboardingLinks'] = [];
  for (const input of linkInputs) {
    const rows = await db
      .insert(schema.onboardingLink)
      .values(input)
      .onConflictDoNothing({ target: schema.onboardingLink.id })
      .returning();
    linkResults.push({ id: input.id, inserted: rows.length > 0 });
  }

  log.log(
    `Seed complete: schema=${schemaInserted ? 'inserted' : 'exists'}, ` +
      `aggregator=${aggInserted ? 'inserted' : 'exists'}, ` +
      `links=${linkResults.filter((l) => l.inserted).length}/${linkResults.length} inserted`,
  );

  return {
    schemaVersion: { id: SEED_IDS.schemaVersion, inserted: schemaInserted },
    aggregator: { aggregatorId: SEED_IDS.aggregator, inserted: aggInserted },
    onboardingLinks: linkResults,
  };
}

/** CLI entry — resolves DATABASE_URL and invokes runSeed. */
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required to run the seed script.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  try {
    await runSeed(db);
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly (not when imported by tests).
const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('scripts/seed.ts');
if (invokedAsScript) {
  main().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}

export { SEED_IDS };
