/**
 * Runs the coordinator profile-types sync (api app script).
 *
 * Makes each coordinator's Keycloak `aggregator_type` match `users.serves`.
 * Writes only Keycloak, never the database. Dry run unless `--apply` is given.
 * Run from a checkout (the api image has no tsx); see
 * `docs/profile-types-sync-runbook.md`:
 *
 *   DATABASE_URL=… KEYCLOAK_URL=… KEYCLOAK_REALM=… \
 *   KEYCLOAK_ADMIN_CLIENT_ID=… KEYCLOAK_ADMIN_CLIENT_SECRET=… AGGREGATOR_NETWORK=… \
 *     pnpm --filter @aggregator-dpg/api exec tsx scripts/sync-coordinator-profile-types.ts [--apply]
 *
 * Prints counts and coordinator ids only. Exits 1 when any Keycloak call failed.
 */
import '../src/env.js';
import { errorMessage, errorType } from '@aggregator-dpg/shared-primitives/errors';
import { closeDb } from '../src/db/client.js';
import { getIdpAdmin } from '../src/services/idp-admin/index.js';
import { getNetworkConfig } from '../src/services/network-config.js';
import { logger } from '../src/logger.js';
import {
  listCoordinatorServesFromDb,
  syncCoordinatorProfileTypes,
} from '../src/services/profile-types-sync.js';

const dryRun = !process.argv.includes('--apply');

try {
  const network = await getNetworkConfig();
  const report = await syncCoordinatorProfileTypes(
    {
      idp: getIdpAdmin(),
      listCoordinators: listCoordinatorServesFromDb,
      domainIds: network.domainIds,
    },
    { dryRun },
  );
  const failed = report.failedIds.length > 0;
  logger.info(
    { operation: 'profileTypesSync', status: failed ? 'failure' : 'success', ...report },
    'profile-types sync finished',
  );
  await closeDb();
  process.exit(failed ? 1 : 0);
} catch (err: unknown) {
  logger.error({
    operation: 'profileTypesSync',
    status: 'failure',
    error: errorMessage(err),
    error_type: errorType(err),
  });
  await closeDb().catch(() => undefined);
  process.exit(1);
}
