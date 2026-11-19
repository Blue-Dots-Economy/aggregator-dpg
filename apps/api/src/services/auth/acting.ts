/**
 * Acting-account check (`@aggregator-dpg/api`): an org owner may act as their
 * own coordinator account when both accounts share one IdP login.
 */

import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { err, ok, type Result } from '@aggregator-dpg/shared-primitives/result';
import { ACTING_ACCOUNT_HEADER } from '@aggregator-dpg/shared-primitives/user-org';
import { httpError } from '../../errors/http-error.js';
import { logger } from '../../logger.js';
import type { AuthError } from './access-token.js';
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

/** The `x-acting-account` header of a request. */
export type ActingHeader =
  { kind: 'absent' } | { kind: 'malformed' } | { kind: 'account'; id: string };

const AccountIdSchema = z.guid();

/**
 * The detail of every `403 ACTING_ACCOUNT_INVALID`. The reason is logged
 * (`auth.acting`), never returned.
 */
export const ACTING_INVALID_DETAIL = 'acting account not usable';

/**
 * Reads the `x-acting-account` header once.
 *
 * A repeated header, an empty value or a value that is not a guid is
 * `malformed`; callers refuse it with `403 ACTING_ACCOUNT_INVALID`. The id is
 * returned lower-cased, the form account ids are stored in.
 *
 * @param req - The request.
 * @returns The header state.
 */
export function readActingHeader(req: FastifyRequest): ActingHeader {
  const raw = req.headers[ACTING_ACCOUNT_HEADER];
  if (raw === undefined) return { kind: 'absent' };
  const parsed = AccountIdSchema.safeParse(raw);
  return parsed.success
    ? { kind: 'account', id: parsed.data.toLowerCase() }
    : { kind: 'malformed' };
}

/**
 * Logs the outcome of an acting-account check. Carries the status and the
 * error code only, never ids or the subject.
 *
 * @param code - The {@link ActingError} code, or `null` on success.
 */
export function logActing(code: ActingError['code'] | 'MALFORMED' | 'CLAIM_MISMATCH' | null): void {
  if (code === null) logger.debug({ operation: 'auth.acting', status: 'success' });
  else logger.warn({ operation: 'auth.acting', status: 'failure', error: code });
}

/**
 * Throws the HTTP error for a refused or unchecked acting account, for the
 * auth wrappers of the routes that use `requireApproved`. Does nothing for
 * any other error.
 *
 * @param error - The `requireApproved` error.
 * @throws {HttpError} `ACTING_ACCOUNT_INVALID` (403) or `DB_UNAVAILABLE` (503).
 */
export function throwIfActingError(error: AuthError): void {
  if (error.code === 'ACTING_ACCOUNT_INVALID') {
    throw httpError('ACTING_ACCOUNT_INVALID', { detail: ACTING_INVALID_DETAIL });
  }
  if (error.code === 'ACTING_UNAVAILABLE') {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(error.message),
      fields: { sub_operation: 'resolveActingAccount' },
    });
  }
}
