import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { ConsentLedgerFake } from '@aggregator-dpg/consent-ledger/testing';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { IdpAdminFake, KC_ATTR, _setIdpAdmin } from '../../idp-admin/index.js';
import { UserStoreFake, _setUserStore } from '../../user-store/index.js';
import { _setConsentLedger } from '../../consent-ledger/index.js';
import { _setNetworkConfig } from '../../network-config.js';
import { _resetValidator } from '../../registration-validator.js';
import {
  checkCoordinatorForm,
  createCoordinatorWithLogin,
  type CoordinatorForm,
} from '../coordinator-create.js';

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
const ORG_ID = '00000000-0000-4000-8000-0000000000c1';
const COORD_EMAIL = 'asha@trrain.org';

/** A coordinator form without consent, as the loader builds it. */
const form: CoordinatorForm = {
  name: 'TRRAIN',
  type: 'seeker',
  contact: { name: 'Asha Kumari', phone: '+919876543210', email: COORD_EMAIL },
  locations: [],
};

describe('coordinator creation', () => {
  let userStore: UserStoreFake;
  let idp: IdpAdminFake;
  let ledger: ConsentLedgerFake;

  beforeEach(() => {
    userStore = new UserStoreFake();
    idp = new IdpAdminFake();
    ledger = new ConsentLedgerFake();
    _setUserStore(userStore);
    _setIdpAdmin(idp);
    _setConsentLedger(ledger);
    _setNetworkConfig(buildBlueDotConfig());
    _resetValidator();
  });

  afterEach(() => {
    _setUserStore(null);
    _setIdpAdmin(null);
    _setConsentLedger(null);
    _setNetworkConfig(null);
    _resetValidator();
  });

  async function checked() {
    const c = await checkCoordinatorForm(form, { consentRequired: false });
    if (!c.ok) throw new Error(`form check failed: ${c.error.code}`);
    return c.value;
  }

  describe('checkCoordinatorForm', () => {
    it('accepts a form without consent when consent is not required', async () => {
      const r = await checkCoordinatorForm(form, { consentRequired: false });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.consent).toBeNull();
      expect(r.value.phoneE164).toBe('+919876543210');
      expect(r.value.domains).toEqual(['seeker']);
    });

    it('refuses a form without consent when consent is required', async () => {
      const r = await checkCoordinatorForm(form, { consentRequired: true });
      expect(!r.ok && r.error.code).toBe('SCHEMA_VALIDATION');
    });
  });

  describe('createCoordinatorWithLogin', () => {
    it('creates a provisioned coordinator without a consent row and an invited login', async () => {
      const { contact, domains, consent } = await checked();
      const r = await createCoordinatorWithLogin({
        body: form,
        contact,
        domains,
        orgId: ORG_ID,
        createdBy: 'provisioned:ops',
        consent,
        inviteId: null,
        locations: [],
        log,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(ledger.list()).toHaveLength(0);
      const kc = await idp.findById(r.value.kcUserId);
      const attrs = kc.ok ? kc.value?.attributes : undefined;
      expect(attrs?.[KC_ATTR.AGGREGATOR_ID]).toEqual([r.value.userId]);
      expect(attrs?.[KC_ATTR.AGGREGATOR_TYPE]).toEqual(domains);
      expect(attrs?.[KC_ATTR.DECISION_MADE]).toEqual(['invited']);
      const row = await userStore.findById(r.value.userId);
      expect(row.ok && row.value?.createdBy).toBe('provisioned:ops');
      expect(row.ok && row.value?.orgSlug).toBe(r.value.orgSlug);
    });

    it('answers USER_EXISTS and deletes the row when the login is taken', async () => {
      const seeded = await idp.createUser({ email: COORD_EMAIL });
      if (!seeded.ok) throw new Error('seed kc user');
      const { contact, domains, consent } = await checked();
      const r = await createCoordinatorWithLogin({
        body: form,
        contact,
        domains,
        orgId: ORG_ID,
        createdBy: 'provisioned:ops',
        consent,
        inviteId: null,
        locations: [],
        log,
      });
      expect(!r.ok && r.error.code).toBe('USER_EXISTS');
      const row = await userStore.findByContactEmail(COORD_EMAIL);
      expect(row.ok && row.value).toBeNull();
    });

    it('answers IDP_UNAVAILABLE and deletes the row when Keycloak is down', async () => {
      idp.createUser = async () => ({
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: 'down' },
      });
      const { contact, domains, consent } = await checked();
      const r = await createCoordinatorWithLogin({
        body: form,
        contact,
        domains,
        orgId: ORG_ID,
        createdBy: 'provisioned:ops',
        consent,
        inviteId: null,
        locations: [],
        log,
      });
      expect(!r.ok && r.error.code).toBe('IDP_UNAVAILABLE');
      expect(!r.ok && r.error.fields).toMatchObject({
        sub_operation: 'idp.createUser',
        rolled_back: true,
      });
      const row = await userStore.findByContactEmail(COORD_EMAIL);
      expect(row.ok && row.value).toBeNull();
    });

    it('maps a missing consent hook for a self-created coordinator to SCHEMA_VALIDATION', async () => {
      const { contact, domains, consent } = await checked();
      const r = await createCoordinatorWithLogin({
        body: form,
        contact,
        domains,
        orgId: ORG_ID,
        createdBy: 'self',
        consent,
        inviteId: null,
        locations: [],
        log,
      });
      expect(!r.ok && r.error.code).toBe('SCHEMA_VALIDATION');
    });
  });
});
