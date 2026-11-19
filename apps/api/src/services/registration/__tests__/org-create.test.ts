import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { OrganisationStoreFake, _setOrganisationStore } from '../../organisation-store/index.js';
import { IdpAdminFake, KC_ATTR, _setIdpAdmin } from '../../idp-admin/index.js';
import { UserStoreFake, _setUserStore } from '../../user-store/index.js';
import { _setConsentLedger } from '../../consent-ledger/index.js';
import { _setNetworkConfig } from '../../network-config.js';
import { checkOrgForm, createOrgWithOwner, type OrgForm } from '../org-create.js';

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
const OWNER_EMAIL = 'ravi@enable.org';

const form: OrgForm = {
  display_name: 'Enable India',
  state: 'Karnataka',
  owner: { name: 'Ravi Kumar', email: OWNER_EMAIL, phone: '+919876500000' },
};

describe('createOrgWithOwner', () => {
  let orgStore: OrganisationStoreFake;
  let idp: IdpAdminFake;
  let ledger: ConsentLedgerFake;

  beforeEach(() => {
    orgStore = new OrganisationStoreFake();
    idp = new IdpAdminFake();
    ledger = new ConsentLedgerFake();
    _setOrganisationStore(orgStore);
    _setIdpAdmin(idp);
    _setUserStore(new UserStoreFake());
    _setConsentLedger(ledger);
    _setNetworkConfig(buildBlueDotConfig());
  });

  afterEach(() => {
    _setOrganisationStore(null);
    _setIdpAdmin(null);
    _setUserStore(null);
    _setConsentLedger(null);
    _setNetworkConfig(null);
  });

  async function checked() {
    const c = await checkOrgForm(form);
    if (!c.ok) throw new Error(`form check failed: ${c.error.code}`);
    return c.value;
  }

  it('creates a provisioned org without a consent row and an invited owner', async () => {
    const { schemaValues, phoneE164 } = await checked();
    const r = await createOrgWithOwner({
      form,
      schemaValues,
      phoneE164,
      createdBy: 'provisioned:ops',
      log,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ledger.list()).toHaveLength(0);
    const owner = await idp.findById(r.value.ownerKcSub);
    expect(owner.ok && owner.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['invited']);
    const stored = await orgStore.findById(r.value.org.id);
    expect(stored.ok && stored.value).toMatchObject({
      kcGroupId: r.value.groupId,
      ownerKcSub: r.value.ownerKcSub,
      createdBy: 'provisioned:ops',
    });
  });

  it('stamps an existing owner sub instead of creating a Keycloak user', async () => {
    const { schemaValues, phoneE164 } = await checked();
    let created = 0;
    const createUser = idp.createUser.bind(idp);
    idp.createUser = (input) => {
      created += 1;
      return createUser(input);
    };
    const r = await createOrgWithOwner({
      form,
      schemaValues,
      phoneE164,
      createdBy: 'provisioned:ops',
      existingOwnerKcSub: 'kc-1',
      log,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(created).toBe(0);
    expect(r.value.ownerKcSub).toBe('kc-1');
    expect(r.value.org.ownerKcSub).toBe('kc-1');
    const stored = await orgStore.findById(r.value.org.id);
    expect(stored.ok && stored.value?.ownerKcSub).toBe('kc-1');
  });

  it('answers USER_EXISTS and removes the org row and group when the owner login is taken', async () => {
    const seeded = await idp.createUser({ email: OWNER_EMAIL });
    if (!seeded.ok) throw new Error('seed kc user');
    const { schemaValues, phoneE164 } = await checked();
    const r = await createOrgWithOwner({
      form,
      schemaValues,
      phoneE164,
      createdBy: 'provisioned:ops',
      log,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('USER_EXISTS');
    const found = await orgStore.findBySlug('enable-india');
    expect(found.ok && found.value).toBeNull();
    const group = await idp.findGroupByName('org-enable-india');
    expect(group.ok && group.value).toBeNull();
  });

  it('keeps an existing owner user when the stamp fails, and removes the org and group', async () => {
    const existing = await idp.createUser({ email: OWNER_EMAIL });
    if (!existing.ok) throw new Error('seed kc user');
    orgStore.update = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'stamp failed' },
    });
    const { schemaValues, phoneE164 } = await checked();
    const r = await createOrgWithOwner({
      form,
      schemaValues,
      phoneE164,
      createdBy: 'provisioned:ops',
      existingOwnerKcSub: existing.value.id,
      log,
    });
    expect(!r.ok && r.error.code).toBe('DB_UNAVAILABLE');
    const kept = await idp.findById(existing.value.id);
    expect(kept.ok && kept.value?.id).toBe(existing.value.id);
    const found = await orgStore.findBySlug('enable-india');
    expect(found.ok && found.value).toBeNull();
    const group = await idp.findGroupByName('org-enable-india');
    expect(group.ok && group.value).toBeNull();
  });
});
