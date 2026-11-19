/**
 * Unit tests for the owner shared-login check (`services/auth/shared-login.ts`,
 * `@aggregator-dpg/api`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdpAdminFake, _setIdpAdmin, KC_ATTR } from '../idp-admin/index.js';
import { isSharedLogin } from './shared-login.js';

describe('isSharedLogin', () => {
  let idp: IdpAdminFake;

  beforeEach(() => {
    idp = new IdpAdminFake();
    _setIdpAdmin(idp);
  });
  afterEach(() => _setIdpAdmin(null));

  async function user(attributes: Record<string, string> = {}): Promise<string> {
    const created = await idp.createUser({ email: 'owner@example.org', attributes });
    if (!created.ok) throw new Error('fake createUser failed');
    return created.value.id;
  }

  it('is shared for an admin login whose Keycloak user has no aggregator_id', async () => {
    const id = await user();
    expect(await isSharedLogin(id, { admin: 'a1', coordinator: 'c1' })).toEqual({
      ok: true,
      value: true,
    });
  });

  it('is not shared when the Keycloak user carries aggregator_id (a legacy coordinator login)', async () => {
    const id = await user({ [KC_ATTR.AGGREGATOR_ID]: 'c1' });
    expect(await isSharedLogin(id, { admin: 'a1', coordinator: 'c1' })).toEqual({
      ok: true,
      value: false,
    });
  });

  it('is not shared, without a Keycloak read, when no admin account is linked', async () => {
    idp.failOnce({ code: 'IDP_UNAVAILABLE', message: 'down' });
    expect(await isSharedLogin('kc-x', { admin: null, coordinator: 'c1' })).toEqual({
      ok: true,
      value: false,
    });
  });

  it('reports a Keycloak failure', async () => {
    idp.failOnce({ code: 'IDP_UNAVAILABLE', message: 'down' });
    const res = await isSharedLogin('kc-x', { admin: 'a1', coordinator: null });
    expect(res).toMatchObject({ ok: false, error: { code: 'IDP_UNAVAILABLE' } });
  });
});
