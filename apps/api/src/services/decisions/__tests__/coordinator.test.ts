// The coordinator decision service's race handling (design R3): reject is
// compare-and-set first; an approval that loses its compare-and-set to a
// concurrent reject undoes what it did in Keycloak.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { FakeMailer, _setMailer } from '@aggregator-dpg/mailer';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import {
  AggregatorStoreFake,
  buildAggregator,
  _setAggregatorStore,
} from '../../aggregator-store/index.js';
import {
  AggregatorOrgStoreFake,
  buildDefaultOrg,
  _setAggregatorOrgStore,
} from '../../aggregator-org-store/index.js';
import { IdpAdminFake, KC_ATTR, _setIdpAdmin } from '../../idp-admin/index.js';
import { _setNetworkConfig } from '../../network-config.js';
import { _setSignalStackWriter } from '../../signalstack.js';
import { decideCoordinator, LINK_DECIDER } from '../coordinator.js';

const ID = '11111111-1111-4111-8111-111111111111';
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

describe('decideCoordinator', () => {
  let store: AggregatorStoreFake;
  let idp: IdpAdminFake;
  let mailer: FakeMailer;
  let kcId: string;

  beforeEach(async () => {
    store = new AggregatorStoreFake();
    store.seed([
      buildAggregator({
        id: ID,
        status: 'pending',
        parentOrgId: buildDefaultOrg().id,
        isDefaultOrg: true,
      }),
    ]);
    const orgs = new AggregatorOrgStoreFake();
    orgs.seed([buildDefaultOrg()]);
    idp = new IdpAdminFake();
    const user = await idp.createUser({
      email: 'c@x.test',
      enabled: false,
      attributes: { [KC_ATTR.AGGREGATOR_ID]: ID },
    });
    if (!user.ok) throw new Error('seed failed');
    kcId = user.value.id;
    mailer = new FakeMailer();
    _setAggregatorStore(store);
    _setAggregatorOrgStore(orgs);
    _setIdpAdmin(idp);
    _setMailer(mailer);
    _setNetworkConfig(buildBlueDotConfig());
    _setSignalStackWriter(new SignalStackWriterFake());
  });

  afterEach(() => {
    _setAggregatorStore(null);
    _setAggregatorOrgStore(null);
    _setIdpAdmin(null);
    _setMailer(null);
    _setNetworkConfig(null);
    _setSignalStackWriter(null);
  });

  const ADMIN = '00000000-0000-4000-8000-0000000000a1';
  const decide = (decision: 'approve' | 'reject', decidedBy = ADMIN) =>
    decideCoordinator({ aggregatorId: ID, decision, decidedBy, log });

  it('approves: enables the user, records the decider, mails once', async () => {
    const out = await decide('approve');
    expect(out).toEqual({ kind: 'decided', decision: 'approve', notified: true });
    const kc = await idp.findById(kcId);
    expect(kc.ok && kc.value?.enabled).toBe(true);
    const row = await store.findById(ID);
    expect(row.ok && row.value?.updatedBy).toBe(ADMIN);
    expect(mailer.outbox).toHaveLength(1);
  });

  it('undoes Keycloak when a concurrent reject wins the approval compare-and-set', async () => {
    const real = store.approveFromPending.bind(store);
    store.approveFromPending = async (id, by) => {
      // The emailed link rejects between this approval's provisioning and its CAS.
      await store.rejectFromPending(id, LINK_DECIDER);
      return real(id, by);
    };
    const out = await decide('approve');
    expect(out).toMatchObject({ kind: 'already_decided', status: 'inactive', decidedBy: 'link' });
    const kc = await idp.findById(kcId);
    expect(kc.ok && kc.value?.enabled).toBe(false);
    expect(kc.ok && kc.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['rejected']);
    // Only the winner mails (the reject here bypassed the service: no mail at all).
    expect(mailer.outbox).toHaveLength(0);
  });

  it('undoes Keycloak when the approval compare-and-set fails in the database', async () => {
    store.approveFromPending = async () => ({
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'down' },
    });
    expect(await decide('approve')).toEqual({ kind: 'unavailable', dependency: 'db' });
    const kc = await idp.findById(kcId);
    expect(kc.ok && kc.value?.enabled).toBe(false);
    expect(kc.ok && kc.value?.attributes?.[KC_ATTR.DECISION_MADE]).toEqual(['rejected']);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('reports an unknown decider as null, not as the console', async () => {
    await store.approveFromPending(ID, 'self');
    expect(await decide('reject')).toMatchObject({ kind: 'already_decided', decidedBy: null });
  });

  it('a reject that loses its compare-and-set changes nothing and mails nobody', async () => {
    await store.approveFromPending(ID, '00000000-0000-4000-8000-0000000000a2');
    const real = store.rejectFromPending.bind(store);
    let calls = 0;
    store.rejectFromPending = async (id, by) => {
      calls += 1;
      return real(id, by);
    };
    const out = await decide('reject');
    // The pre-read already sees the approval: no CAS attempted.
    expect(out).toMatchObject({ kind: 'already_decided', status: 'active', decidedBy: 'console' });
    expect(calls).toBe(0);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('answers already_decided when the reject CAS itself loses', async () => {
    store.rejectFromPending = async () => {
      await store.approveFromPending(ID, LINK_DECIDER);
      return { ok: true, value: null };
    };
    const out = await decide('reject');
    expect(out).toMatchObject({ kind: 'already_decided', status: 'active', decidedBy: 'link' });
    expect(mailer.outbox).toHaveLength(0);
  });

  it('refuses to approve into an inactive org', async () => {
    const orgs = new AggregatorOrgStoreFake();
    orgs.seed([{ ...buildDefaultOrg(), status: 'inactive' }]);
    _setAggregatorOrgStore(orgs);
    expect(await decide('approve')).toEqual({ kind: 'org_inactive' });
  });
});
