import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { IdpAdminFake, _setIdpAdmin, KC_ATTR } from '../idp-admin/index.js';
import { UserStoreFake, _setUserStore } from '../user-store/index.js';
import { OrganisationStoreFake, _setOrganisationStore } from '../organisation-store/index.js';
import { activateInvitedAccount } from './activate.js';

/** A logger whose `warn` calls are recorded; `child` returns the same logger. */
function recordingLog(): { log: FastifyBaseLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const log = { warn, info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
  (log as unknown as { child: () => FastifyBaseLogger }).child = () => log;
  return { log, warn };
}

describe('activateInvitedAccount logging', () => {
  let idp: IdpAdminFake;
  let users: UserStoreFake;

  beforeEach(() => {
    idp = new IdpAdminFake();
    users = new UserStoreFake();
    _setIdpAdmin(idp);
    _setUserStore(users);
    _setOrganisationStore(new OrganisationStoreFake());
  });

  it('logs the failed Keycloak read and its code', async () => {
    idp.findById = async () => ({ ok: false, error: { code: 'BAD_REQUEST', message: 'x' } });
    const { log, warn } = recordingLog();

    const outcome = await activateInvitedAccount('sub-1', log, 'req-1');

    expect(outcome).toEqual({ kind: 'unavailable', dependency: 'idp' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failure',
        outcome: 'unavailable',
        sub_operation: 'idp.findById',
        code: 'BAD_REQUEST',
      }),
      'invite activation stopped',
    );
  });

  it('logs a login with no coordinator behind it, without its email', async () => {
    const created = await idp.createUser({
      email: 'asha@trrain.org',
      enabled: true,
      emailVerified: true,
      attributes: { [KC_ATTR.DECISION_MADE]: 'invited', [KC_ATTR.AGGREGATOR_ID]: 'missing-row' },
    });
    if (!created.ok) throw new Error('seed');
    const { log, warn } = recordingLog();

    const outcome = await activateInvitedAccount(created.value.id, log, 'req-1');

    expect(outcome).toEqual({ kind: 'not_found' });
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ reason: 'no_coordinator', aggregator_id: 'missing-row' });
    expect(JSON.stringify(fields)).not.toContain('asha@trrain.org');
  });

  it('logs a subject that has no Keycloak user', async () => {
    const { log, warn } = recordingLog();

    const outcome = await activateInvitedAccount('nobody', log, 'req-1');

    expect(outcome).toEqual({ kind: 'not_found' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no_idp_user' }),
      'invite activation stopped',
    );
  });
});
