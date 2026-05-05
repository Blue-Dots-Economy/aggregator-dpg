import { describe, it, expect, beforeEach } from 'vitest';
import { IdpAdminFake } from './testing.js';

describe('IdpAdminFake', () => {
  let admin: IdpAdminFake;

  beforeEach(() => {
    admin = new IdpAdminFake();
  });

  it('createUser returns the new user with generated id', async () => {
    const r = await admin.createUser({
      email: 'a@b.in',
      firstName: 'A',
      lastName: 'B',
      phone: '+919876543210',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.value.email).toBe('a@b.in');
      expect(r.value.enabled).toBe(true);
    }
  });

  it('createUser rejects duplicate email', async () => {
    await admin.createUser({ email: 'a@b.in' });
    const r = await admin.createUser({ email: 'a@b.in' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('USER_EXISTS');
  });

  it('findByEmail returns null when none exists', async () => {
    const r = await admin.findByEmail('missing@x.y');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('findByEmail returns the matching user', async () => {
    await admin.createUser({ email: 'A@B.IN' });
    const r = await admin.findByEmail('a@b.in');
    expect(r.ok).toBe(true);
    if (r.ok && r.value) expect(r.value.email).toBe('A@B.IN');
  });

  it('enableUser flips the flag', async () => {
    const c = await admin.createUser({ email: 'a@b.in', enabled: false });
    if (!c.ok) throw new Error('create failed');
    const r = await admin.enableUser(c.value.id);
    expect(r.ok).toBe(true);
    const found = await admin.findByEmail('a@b.in');
    if (found.ok && found.value) expect(found.value.enabled).toBe(true);
  });

  it('disableUser flips the flag', async () => {
    const c = await admin.createUser({ email: 'a@b.in' });
    if (!c.ok) throw new Error('create failed');
    const r = await admin.disableUser(c.value.id);
    expect(r.ok).toBe(true);
    const found = await admin.findByEmail('a@b.in');
    if (found.ok && found.value) expect(found.value.enabled).toBe(false);
  });

  it('enableUser returns USER_NOT_FOUND for unknown id', async () => {
    const r = await admin.enableUser('nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('USER_NOT_FOUND');
  });

  it('deleteUser removes', async () => {
    const c = await admin.createUser({ email: 'a@b.in' });
    if (!c.ok) throw new Error('create failed');
    const d = await admin.deleteUser(c.value.id);
    expect(d.ok).toBe(true);
    const found = await admin.findByEmail('a@b.in');
    if (found.ok) expect(found.value).toBeNull();
  });

  it('findById returns the matching user', async () => {
    const c = await admin.createUser({ email: 'a@b.in' });
    if (!c.ok) throw new Error('create failed');
    const r = await admin.findById(c.value.id);
    expect(r.ok).toBe(true);
    if (r.ok && r.value) expect(r.value.id).toBe(c.value.id);
  });

  it('findById returns null for unknown id', async () => {
    const r = await admin.findById('00000000-0000-0000-0000-deadbeefdead');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('findByAttribute returns the matching user', async () => {
    await admin.createUser({
      email: 'a@b.in',
      attributes: { aggregator_id: 'agg-123', org_slug: 'foo' },
    });
    const r = await admin.findByAttribute('aggregator_id', 'agg-123');
    expect(r.ok).toBe(true);
    if (r.ok && r.value) expect(r.value.email).toBe('a@b.in');
  });

  it('findByAttribute returns null when no match', async () => {
    await admin.createUser({
      email: 'a@b.in',
      attributes: { aggregator_id: 'agg-123' },
    });
    const r = await admin.findByAttribute('aggregator_id', 'agg-999');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('failOnce forces the next call to fail', async () => {
    admin.failOnce({ code: 'IDP_UNAVAILABLE', message: 'kc down' });
    const r = await admin.createUser({ email: 'x@y.z' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('IDP_UNAVAILABLE');
    // next call should succeed
    const r2 = await admin.createUser({ email: 'x@y.z' });
    expect(r2.ok).toBe(true);
  });
});
