/**
 * Runner for the one-off org-owner name backfill (the `contact` table, migrations 0025/0026).
 *
 * Run ONCE per existing instance after the release that ships migration 0025,
 * from a checkout (the api image has no tsx):
 *
 *   DATABASE_URL=… KEYCLOAK_URL=… KEYCLOAK_REALM=… \
 *   KEYCLOAK_ADMIN_CLIENT_ID=… KEYCLOAK_ADMIN_CLIENT_SECRET=… \
 *     pnpm --filter @aggregator-dpg/api exec tsx scripts/backfill-owner-contact-names.ts [--dry-run]
 *
 * Prints outcome counts only. Then check `scripts/sql/contact-verify.sql` V5.
 */
import '../src/env.js';
import { closeDb } from '../src/db/client.js';
import { getIdpAdmin } from '../src/services/idp-admin/index.js';
import { logger } from '../src/logger.js';
import {
  backfillOwnerContactNames,
  listOwnerNameCandidatesFromDb,
  setContactNameIfMissingInDb,
} from '../src/services/owner-name-backfill.js';

const dryRun = process.argv.includes('--dry-run');

backfillOwnerContactNames(
  {
    idp: getIdpAdmin(),
    listCandidates: listOwnerNameCandidatesFromDb,
    setNameIfMissing: setContactNameIfMissingInDb,
  },
  { dryRun },
)
  .then(async (report) => {
    logger.info(
      { operation: 'ownerNameBackfill', status: 'success', ...report },
      'owner-name backfill finished',
    );
    await closeDb();
    process.exit(report.failed > 0 ? 1 : 0);
  })
  .catch(async (err: unknown) => {
    logger.error({
      operation: 'ownerNameBackfill',
      status: 'failure',
      error: (err as Error).message,
      error_type: (err as Error).constructor?.name,
    });
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
