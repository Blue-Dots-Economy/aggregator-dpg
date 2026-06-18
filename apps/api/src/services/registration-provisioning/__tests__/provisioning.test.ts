import { describe, it, expect, beforeEach } from 'vitest';
import {
  ensureVerificationSent,
  ensureAdminNotified,
  ensureKeycloakUser,
  ensureKeycloakUserDisabled,
  ensureGraduated,
  ensureWelcomeSent,
  ensureRejectionSent,
  ensurePurged,
} from '../index.js';
import { RegistrationStoreFake, buildRegistration } from '../../registration-store/testing.js';
import { FakeMailer } from '../../mailer/testing.js';
import { IdpAdminFake } from '../../idp-admin/testing.js';
import { AggregatorStoreFake } from '../../aggregator-store/testing.js';
import { AggregatorProfileStoreFake } from '../../aggregator-profile-store/testing.js';
import { KC_ATTR } from '../../idp-admin/attributes.js';
import { _resetTokenKey } from '../../approval-token.js';

let store: RegistrationStoreFake;
let mailer: FakeMailer;
let idpAdmin: IdpAdminFake;
let aggStore: AggregatorStoreFake;
let aggProfileStore: AggregatorProfileStoreFake;

beforeEach(() => {
  // approval-token reads APPROVAL_TOKEN_SECRET at key-cache time; reset + inject.
  _resetTokenKey();
  process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);

  store = new RegistrationStoreFake();
  mailer = new FakeMailer();
  idpAdmin = new IdpAdminFake();
  aggStore = new AggregatorStoreFake();
  aggProfileStore = new AggregatorProfileStoreFake();
});

// ─── ensureVerificationSent ───────────────────────────────────────────────────

describe('ensureVerificationSent', () => {
  const deps = () => ({
    store,
    mailer,
    portalUrl: 'http://portal.test',
    cooldownMinutes: 5,
    ttlMinutes: 60,
  });

  it('sends verification email on first call', async () => {
    const reg = buildRegistration({ state: 'submitted' });
    store.seed([reg]);

    const result = await ensureVerificationSent(reg, deps());

    expect(result.ok).toBe(true);
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]!.to).toBe(reg.contactEmail);
    expect(mailer.outbox[0]!.subject).toContain('Verify');

    const loaded = await store.findById(reg.id);
    expect(loaded.ok && loaded.value?.provisionState.verification).toBe('done');
  });

  it('skips when already done', async () => {
    const reg = buildRegistration({ state: 'submitted', provisionState: { verification: 'done' } });
    store.seed([reg]);

    await ensureVerificationSent(reg, deps());
    await ensureVerificationSent(reg, deps());

    expect(mailer.outbox).toHaveLength(0);
  });

  it('skips during cooldown window', async () => {
    const sentRecently = new Date(Date.now() - 2 * 60_000); // 2 min ago
    const reg = buildRegistration({ state: 'submitted', verificationSentAt: sentRecently });
    store.seed([reg]);

    const result = await ensureVerificationSent(reg, deps());

    expect(result.ok).toBe(true);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('marks failed and returns ok:false when mail send fails', async () => {
    const reg = buildRegistration({ state: 'submitted' });
    store.seed([reg]);

    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'smtp down' });
    const result = await ensureVerificationSent(reg, deps());

    expect(result.ok).toBe(false);
    const loaded = await store.findById(reg.id);
    expect(loaded.ok && loaded.value?.provisionState.verification).toBe('failed');
  });
});

// ─── ensureAdminNotified ──────────────────────────────────────────────────────

describe('ensureAdminNotified', () => {
  const deps = () => ({
    store,
    mailer,
    apiUrl: 'http://api.test',
    adminEmails: ['admin@test.local'],
    cooldownMinutes: 5,
  });

  it('sends admin notification on first call', async () => {
    const reg = buildRegistration({ state: 'verified' });
    store.seed([reg]);

    const result = await ensureAdminNotified(reg, deps());

    expect(result.ok).toBe(true);
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]!.to).toEqual(['admin@test.local']);

    const loaded = await store.findById(reg.id);
    expect(loaded.ok && loaded.value?.provisionState.admin_notify).toBe('done');
  });

  it('skips when already done', async () => {
    const reg = buildRegistration({ state: 'verified', provisionState: { admin_notify: 'done' } });
    store.seed([reg]);

    await ensureAdminNotified(reg, deps());
    await ensureAdminNotified(reg, deps());

    expect(mailer.outbox).toHaveLength(0);
  });

  it('skips when no admin emails configured', async () => {
    const reg = buildRegistration({ state: 'verified' });
    store.seed([reg]);

    const result = await ensureAdminNotified(reg, { ...deps(), adminEmails: [] });

    expect(result.ok).toBe(true);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('marks failed on send error', async () => {
    const reg = buildRegistration({ state: 'verified' });
    store.seed([reg]);

    mailer.failOnce({ code: 'TRANSPORT_FAILED', message: 'smtp down' });
    const result = await ensureAdminNotified(reg, deps());

    expect(result.ok).toBe(false);
    const loaded = await store.findById(reg.id);
    expect(loaded.ok && loaded.value?.provisionState.admin_notify).toBe('failed');
  });
});

// ─── ensureKeycloakUser ───────────────────────────────────────────────────────

describe('ensureKeycloakUser', () => {
  const deps = () => ({ store, idpAdmin, maxAttempts: 5 });

  it('creates KC user and marks done', async () => {
    const reg = buildRegistration({ state: 'approved', aggregatorId: 'agg-1' });
    store.seed([reg]);

    const result = await ensureKeycloakUser(reg, deps());

    expect(result.ok).toBe(true);
    const loaded = await store.findById(reg.id);
    expect(loaded.ok && loaded.value?.provisionState.kc_user).toBe('done');

    const kcUser = await idpAdmin.findByEmail(reg.contactEmail);
    expect(kcUser.ok).toBe(true);
    if (!kcUser.ok) return;
    expect(kcUser.value?.enabled).toBe(true);
    expect(kcUser.value?.attributes?.[KC_ATTR.DECISION_MADE]?.[0]).toBe('approved');
  });

  it('is idempotent — second call skips creation', async () => {
    const reg = buildRegistration({ state: 'approved', aggregatorId: 'agg-1' });
    store.seed([reg]);

    await ensureKeycloakUser(reg, deps());
    const result = await ensureKeycloakUser(
      buildRegistration({ ...reg, provisionState: { kc_user: 'done' } }),
      deps(),
    );

    expect(result.ok).toBe(true);
    // Only one user in KC.
    const lookup = await idpAdmin.findByEmail(reg.contactEmail);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.value?.email).toBe(reg.contactEmail);
  });

  it('reuses existing KC user found by email', async () => {
    // Pre-create a KC user (simulates a concurrent-creation scenario).
    await idpAdmin.createUser({
      email: 'applicant@example.com',
      phone: '+919876543210',
      enabled: false,
    });

    const reg = buildRegistration({ state: 'approved', aggregatorId: 'agg-1' });
    store.seed([reg]);

    const result = await ensureKeycloakUser(reg, deps());
    expect(result.ok).toBe(true);
  });

  it('marks failed and returns ok:false on IDP error', async () => {
    const reg = buildRegistration({ state: 'approved' });
    store.seed([reg]);

    idpAdmin.failOnce({ code: 'IDP_UNAVAILABLE', message: 'KC down' });
    const result = await ensureKeycloakUser(reg, deps());

    expect(result.ok).toBe(false);
    const loaded = await store.findById(reg.id);
    expect(loaded.ok && loaded.value?.provisionState.kc_user).toBe('failed');
  });
});

// ─── ensureKeycloakUserDisabled ───────────────────────────────────────────────

describe('ensureKeycloakUserDisabled', () => {
  const deps = () => ({ store, idpAdmin, maxAttempts: 5 });

  it('disables an existing KC user', async () => {
    const created = await idpAdmin.createUser({
      email: 'applicant@example.com',
      phone: '+919876543210',
      enabled: true,
    });
    const userId = created.ok ? created.value.id : '';

    const reg = buildRegistration({ state: 'rejected', idpUserId: userId });
    store.seed([reg]);

    const result = await ensureKeycloakUserDisabled(reg, deps());

    expect(result.ok).toBe(true);
    const loaded = await store.findById(reg.id);
    expect(loaded.ok && loaded.value?.provisionState.kc_disabled).toBe('done');

    const kcUser = await idpAdmin.findById(userId);
    expect(kcUser.ok).toBe(true);
    if (!kcUser.ok) return;
    expect(kcUser.value?.enabled).toBe(false);
  });

  it('marks done when no KC user exists', async () => {
    const reg = buildRegistration({ state: 'rejected', idpUserId: null });
    store.seed([reg]);

    const result = await ensureKeycloakUserDisabled(reg, deps());

    expect(result.ok).toBe(true);
    const loaded = await store.findById(reg.id);
    expect(loaded.ok && loaded.value?.provisionState.kc_disabled).toBe('done');
  });
});

// ─── ensureGraduated ─────────────────────────────────────────────────────────

describe('ensureGraduated', () => {
  const deps = () => ({
    store,
    aggregatorStore: aggStore,
    aggregatorProfileStore: aggProfileStore,
    maxAttempts: 5,
  });

  it('creates aggregator row and transitions to active', async () => {
    const reg = buildRegistration({ state: 'approved', version: 0 });
    store.seed([reg]);

    const result = await ensureGraduated(reg, deps());

    expect(result.ok).toBe(true);

    const loaded = await store.findById(reg.id);
    expect(loaded.ok && loaded.value?.state).toBe('active');
    expect(loaded.ok && loaded.value?.aggregatorId).toBeTruthy();
  });

  it('skips when already active', async () => {
    const reg = buildRegistration({
      state: 'active',
      aggregatorId: 'agg-existing',
      provisionState: { graduated: 'done' },
    });
    store.seed([reg]);

    const result = await ensureGraduated(reg, deps());

    expect(result.ok).toBe(true);
    // No new aggregator was created.
    const list = await aggStore.list({ limit: 10, offset: 0 });
    expect(list.ok && list.value.rows).toHaveLength(0);
  });

  it('skips when graduated provision key is done', async () => {
    const reg = buildRegistration({ state: 'approved', provisionState: { graduated: 'done' } });
    store.seed([reg]);

    const result = await ensureGraduated(reg, deps());
    expect(result.ok).toBe(true);
    // No new aggregator should be created.
    const list = await aggStore.list({ limit: 10, offset: 0 });
    expect(list.ok && list.value.rows).toHaveLength(0);
  });

  it('is idempotent when called twice with stale snapshot', async () => {
    const reg = buildRegistration({ state: 'approved', version: 0 });
    store.seed([reg]);

    // First graduation succeeds; transitions to active.
    const first = await ensureGraduated(reg, deps());
    expect(first.ok).toBe(true);

    // Second call with the same stale snapshot: ensureGraduated re-reads the
    // store, sees the row is now active, and returns ok:true without retrying.
    const result = await ensureGraduated(reg, deps());
    expect(result.ok).toBe(true);

    // Only one aggregator should have been created.
    const list = await aggStore.list({ limit: 10, offset: 0 });
    expect(list.ok && list.value.rows).toHaveLength(1);
  });
});

// ─── ensureWelcomeSent ────────────────────────────────────────────────────────

describe('ensureWelcomeSent', () => {
  const deps = () => ({
    store,
    mailer,
    portalUrl: 'http://portal.test',
    maxAttempts: 5,
    cooldownMinutes: 60,
  });

  it('sends welcome email', async () => {
    const reg = buildRegistration({ state: 'active' });
    store.seed([reg]);

    const result = await ensureWelcomeSent(reg, deps());

    expect(result.ok).toBe(true);
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]!.to).toBe(reg.contactEmail);

    const loaded = await store.findById(reg.id);
    expect(loaded.ok && loaded.value?.provisionState.welcome).toBe('done');
  });

  it('skips when already done', async () => {
    const reg = buildRegistration({ state: 'active', provisionState: { welcome: 'done' } });
    store.seed([reg]);

    await ensureWelcomeSent(reg, deps());
    expect(mailer.outbox).toHaveLength(0);
  });
});

// ─── ensureRejectionSent ──────────────────────────────────────────────────────

describe('ensureRejectionSent', () => {
  const deps = () => ({
    store,
    mailer,
    reason: 'Does not meet criteria.',
    maxAttempts: 5,
    cooldownMinutes: 60,
  });

  it('sends rejection email with reason', async () => {
    const reg = buildRegistration({ state: 'rejected' });
    store.seed([reg]);

    const result = await ensureRejectionSent(reg, deps());

    expect(result.ok).toBe(true);
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]!.text).toContain('Does not meet criteria');

    const loaded = await store.findById(reg.id);
    expect(loaded.ok && loaded.value?.provisionState.rejection).toBe('done');
  });

  it('skips when already done', async () => {
    const reg = buildRegistration({ state: 'rejected', provisionState: { rejection: 'done' } });
    store.seed([reg]);

    await ensureRejectionSent(reg, deps());
    expect(mailer.outbox).toHaveLength(0);
  });
});

// ─── ensurePurged ─────────────────────────────────────────────────────────────

describe('ensurePurged', () => {
  it('deletes KC user when idpUserId is set', async () => {
    const created = await idpAdmin.createUser({
      email: 'applicant@example.com',
      phone: '+919876543210',
      enabled: true,
    });
    const userId = created.ok ? created.value.id : '';

    const reg = buildRegistration({ state: 'abandoned', idpUserId: userId });
    store.seed([reg]);

    const result = await ensurePurged(reg, { store, idpAdmin, maxAttempts: 5 });

    expect(result.ok).toBe(true);
    const kcUser = await idpAdmin.findById(userId);
    expect(kcUser.ok && kcUser.value).toBeNull();
  });

  it('skips when no idpAdmin provided', async () => {
    const reg = buildRegistration({ state: 'abandoned', idpUserId: 'kc-user-1' });
    store.seed([reg]);

    const result = await ensurePurged(reg, { store, idpAdmin: null, maxAttempts: 5 });
    expect(result.ok).toBe(true);
  });

  it('succeeds even when KC user is already gone', async () => {
    const reg = buildRegistration({ state: 'abandoned', idpUserId: 'nonexistent-user' });
    store.seed([reg]);

    const result = await ensurePurged(reg, { store, idpAdmin, maxAttempts: 5 });
    expect(result.ok).toBe(true);
  });
});
