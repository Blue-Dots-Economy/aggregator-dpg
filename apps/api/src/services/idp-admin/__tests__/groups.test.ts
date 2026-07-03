import { describe, it, expect } from 'vitest';
import { IdpAdminFake } from '../testing.js';

describe('IdpAdminFake group + role ops', () => {
  it('creates a group and returns an id', async () => {
    const idp = new IdpAdminFake();
    const r = await idp.createGroup('org-enable-india', { org_id: 'org-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(typeof r.value.id).toBe('string');
  });

  it('adds a user to a group and assigns a realm role', async () => {
    const idp = new IdpAdminFake();
    const u = await idp.createUser({ email: 'owner@x.org', enabled: true });
    const g = await idp.createGroup('org-x');
    if (!u.ok || !g.ok) throw new Error('setup failed');
    const add = await idp.addUserToGroup(u.value.id, g.value.id);
    const role = await idp.assignRealmRole(u.value.id, 'org_owner');
    expect(add.ok).toBe(true);
    expect(role.ok).toBe(true);
  });

  it('addUserToGroup rejects an unknown group', async () => {
    const idp = new IdpAdminFake();
    const u = await idp.createUser({ email: 'o2@x.org', enabled: true });
    if (!u.ok) throw new Error('setup failed');
    const add = await idp.addUserToGroup(u.value.id, 'no-such-group');
    expect(add.ok).toBe(false);
  });
});
