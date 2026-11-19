/**
 * Acting-account check (`@aggregator-dpg/api`): an org owner may act as their
 * own coordinator account when both accounts share one IdP login.
 */

import { err, ok, type Result } from '@aggregator-dpg/shared-primitives/result';
import { logger } from '../../logger.js';
import { getIdentityStore } from '../identity-store/index.js';
import { IDP_PROVIDER } from '../idp-admin/provider.js';
import { getOrganisationStore } from '../organisation-store/index.js';
import { getUserStore, type Coordinator } from '../user-store/index.js';

/** Why an acting account cannot be used. */
export interface ActingError {
  code: 'NOT_LINKED' | 'NOT_SHARED_LOGIN' | 'INACTIVE' | 'UNAVAILABLE';
  message: string;
}

const OPERATION = 'resolveActingAccount';

function unavailable(source: string): Result<never, ActingError> {
  logger.warn({ operation: OPERATION, status: 'failure', error: 'UNAVAILABLE', source });
  return err({ code: 'UNAVAILABLE', message: `${source} unavailable` });
}

/**
 * Checks that the login `subject` may act as coordinator account `accountId`.
 *
 * In order: the account is the coordinator linked to this login
 * (`NOT_LINKED`); the same login also holds an admin account
 * (`NOT_SHARED_LOGIN`); the coordinator is `active` and its org is `active`
 * (`INACTIVE`). A store failure is `UNAVAILABLE`.
 *
 * @param subject - The IdP subject of the caller.
 * @param accountId - The coordinator account to act as.
 * @returns The coordinator row, or the reason it cannot be used.
 */
export async function resolveActingAccount(
  subject: string,
  accountId: string,
): Promise<Result<Coordinator, ActingError>> {
  const accounts = await getIdentityStore().accountsOf(IDP_PROVIDER, subject);
  if (!accounts.ok) return unavailable('identity store');
  if (accounts.value.coordinator !== accountId) {
    return err({ code: 'NOT_LINKED', message: 'account is not linked to this login' });
  }
  if (accounts.value.admin === null) {
    return err({ code: 'NOT_SHARED_LOGIN', message: 'login holds no owner account' });
  }

  const found = await getUserStore().findById(accountId);
  if (!found.ok) return unavailable('user store');
  const coordinator = found.value;
  if (!coordinator || coordinator.status !== 'active' || coordinator.parentOrgId === null) {
    return err({ code: 'INACTIVE', message: 'coordinator account is not active' });
  }

  const org = await getOrganisationStore().findById(coordinator.parentOrgId);
  if (!org.ok) return unavailable('organisation store');
  if (!org.value || org.value.status !== 'active') {
    return err({ code: 'INACTIVE', message: 'organisation is not active' });
  }
  return ok(coordinator);
}
