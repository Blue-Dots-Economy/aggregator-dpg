/**
 * Unit tests for the in-memory identity store (`@aggregator-dpg/api`): the same
 * rules as the Postgres adapter — link once, never overwrite, one account per
 * external login.
 */
import { describe, expect, it } from 'vitest';
import { IdentityStoreFake, buildIdentity } from '../testing.js';

describe('InMemoryIdentityStore', () => {
  it('links once, then reports already', async () => {
    const s = new IdentityStoreFake();
    expect(await s.link('u1', 'keycloak', 's1')).toEqual({ ok: true, value: 'linked' });
    expect(await s.link('u1', 'keycloak', 's1')).toEqual({ ok: true, value: 'already' });
    expect(await s.subjectOf('u1', 'keycloak')).toEqual({ ok: true, value: 's1' });
    expect(await s.userOf('keycloak', 's1')).toEqual({ ok: true, value: 'u1' });
  });

  it('never overwrites a different subject (MISMATCH)', async () => {
    const s = new IdentityStoreFake();
    s.seed([buildIdentity({ userId: 'u1', subject: 's1' })]);
    const r = await s.link('u1', 'keycloak', 's2');
    expect(r.ok || r.error.code).toBe('MISMATCH');
    expect(await s.subjectOf('u1', 'keycloak')).toEqual({ ok: true, value: 's1' });
  });

  it('refuses a subject linked to another account (DUPLICATE)', async () => {
    const s = new IdentityStoreFake();
    s.seed([buildIdentity({ userId: 'u1', subject: 's1' })]);
    const r = await s.link('u2', 'keycloak', 's1');
    expect(r.ok || r.error.code).toBe('DUPLICATE');
  });

  it('keeps providers independent (another IdP is a new provider value)', async () => {
    const s = new IdentityStoreFake();
    await s.link('u1', 'keycloak', 's1');
    expect(await s.link('u1', 'other-idp', 'x9')).toEqual({ ok: true, value: 'linked' });
    expect(s.all()).toHaveLength(2);
  });

  it('returns null for unknown users and subjects', async () => {
    const s = new IdentityStoreFake();
    expect(await s.subjectOf('nobody', 'keycloak')).toEqual({ ok: true, value: null });
    expect(await s.userOf('keycloak', 'nobody')).toEqual({ ok: true, value: null });
  });

  describe('one account per type per login', () => {
    function seeded(): IdentityStoreFake {
      const s = new IdentityStoreFake();
      s.registerAccount('admin-1', 'admin');
      s.registerAccount('coord-1', 'coordinator');
      s.registerAccount('coord-2', 'coordinator');
      return s;
    }

    it('lets a coordinator link the login an admin already holds', async () => {
      const s = seeded();
      expect(await s.link('admin-1', 'keycloak', 'sub-1')).toEqual({ ok: true, value: 'linked' });
      expect(await s.link('coord-1', 'keycloak', 'sub-1')).toEqual({ ok: true, value: 'linked' });
    });

    it('refuses a second coordinator on the same login (DUPLICATE)', async () => {
      const s = seeded();
      await s.link('admin-1', 'keycloak', 'sub-1');
      await s.link('coord-1', 'keycloak', 'sub-1');
      const r = await s.link('coord-2', 'keycloak', 'sub-1');
      expect(r.ok || r.error.code).toBe('DUPLICATE');
    });

    it('prefers the admin account when no type is given', async () => {
      const s = seeded();
      await s.link('coord-1', 'keycloak', 'sub-1');
      await s.link('admin-1', 'keycloak', 'sub-1');
      expect(await s.userOf('keycloak', 'sub-1')).toEqual({ ok: true, value: 'admin-1' });
    });

    it('returns the account of the requested type', async () => {
      const s = seeded();
      await s.link('admin-1', 'keycloak', 'sub-1');
      await s.link('coord-1', 'keycloak', 'sub-1');
      expect(await s.userOf('keycloak', 'sub-1', 'coordinator')).toEqual({
        ok: true,
        value: 'coord-1',
      });
      expect(await s.userOf('keycloak', 'sub-1', 'admin')).toEqual({ ok: true, value: 'admin-1' });
    });

    it('returns the coordinator when the login has no admin', async () => {
      const s = seeded();
      await s.link('coord-1', 'keycloak', 'sub-1');
      expect(await s.userOf('keycloak', 'sub-1')).toEqual({ ok: true, value: 'coord-1' });
      expect(await s.userOf('keycloak', 'sub-1', 'admin')).toEqual({ ok: true, value: null });
    });

    it('lists both accounts of a login', async () => {
      const s = seeded();
      await s.link('admin-1', 'keycloak', 'sub-1');
      await s.link('coord-1', 'keycloak', 'sub-1');
      expect(await s.accountsOf('keycloak', 'sub-1')).toEqual({
        ok: true,
        value: { admin: 'admin-1', coordinator: 'coord-1' },
      });
      expect(await s.accountsOf('keycloak', 'nobody')).toEqual({
        ok: true,
        value: { admin: null, coordinator: null },
      });
    });
  });
});
