import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRegistrationStore } from '../memory.js';
import { buildCreateRegistrationInput } from '../testing.js';

let store: InMemoryRegistrationStore;

beforeEach(() => {
  store = new InMemoryRegistrationStore();
});

describe('create', () => {
  it('creates a registration in submitted state', async () => {
    const input = buildCreateRegistrationInput();
    const result = await store.create(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('submitted');
    expect(result.value.version).toBe(0);
    expect(result.value.contactEmail).toBe('applicant@example.com');
  });

  it('normalises email to lowercase on create', async () => {
    const input = buildCreateRegistrationInput({ contactEmail: 'UPPER@EXAMPLE.COM' });
    const result = await store.create(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contactEmail).toBe('upper@example.com');
  });

  it('returns DUPLICATE_IDEMPOTENCY_KEY on replay', async () => {
    const input = buildCreateRegistrationInput();
    await store.create(input);
    const replay = await store.create(input);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.code).toBe('DUPLICATE_IDEMPOTENCY_KEY');
  });

  it('returns DUPLICATE_EMAIL for same email in non-terminal row', async () => {
    await store.create(buildCreateRegistrationInput());
    const dup = await store.create(
      buildCreateRegistrationInput({ idempotencyKey: 'other-key', contactPhone: '+919999999999' }),
    );
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.error.code).toBe('DUPLICATE_EMAIL');
  });

  it('returns DUPLICATE_PHONE for same phone in non-terminal row', async () => {
    await store.create(buildCreateRegistrationInput());
    const dup = await store.create(
      buildCreateRegistrationInput({
        idempotencyKey: 'other-key',
        contactEmail: 'other@example.com',
      }),
    );
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.error.code).toBe('DUPLICATE_PHONE');
  });

  it('allows same email after row is abandoned', async () => {
    const first = await store.create(buildCreateRegistrationInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Transition the first registration to abandoned.
    await store.transition(first.value.id, 'submitted', 'abandoned', {}, 0, {
      actor: 'reconciler',
    });

    // Now create a new one with the same contact details.
    const second = await store.create(
      buildCreateRegistrationInput({ idempotencyKey: 'new-key-002' }),
    );
    expect(second.ok).toBe(true);
  });
});

describe('findByIdempotencyKey', () => {
  it('returns null for unknown key', async () => {
    const result = await store.findByIdempotencyKey('unknown');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns the row for a known key', async () => {
    const input = buildCreateRegistrationInput();
    await store.create(input);
    const result = await store.findByIdempotencyKey(input.idempotencyKey);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.idempotencyKey).toBe(input.idempotencyKey);
  });
});

describe('findByContact', () => {
  it('returns null when no match', async () => {
    const result = await store.findByContact('email', 'nobody@example.com');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('finds a non-terminal row by email', async () => {
    const input = buildCreateRegistrationInput();
    await store.create(input);
    const result = await store.findByContact('email', input.contactEmail);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.contactEmail).toBe(input.contactEmail.toLowerCase());
  });

  it('does not find a terminal row by email', async () => {
    const created = await store.create(buildCreateRegistrationInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await store.transition(created.value.id, 'submitted', 'rejected', {}, 0, { actor: 'admin' });
    const result = await store.findByContact('email', 'applicant@example.com');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });
});

describe('transition (compare-and-set)', () => {
  it('advances state and bumps version on valid transition', async () => {
    const created = await store.create(buildCreateRegistrationInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { id, version } = created.value;

    const result = await store.transition(id, 'submitted', 'verified', {}, version, {
      actor: 'applicant',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('verified');
    expect(result.value.version).toBe(1);
  });

  it('returns STALE_TRANSITION when version is stale', async () => {
    const created = await store.create(buildCreateRegistrationInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { id } = created.value;

    // First transition succeeds.
    await store.transition(id, 'submitted', 'verified', {}, 0, { actor: 'applicant' });

    // Second attempt with old version fails.
    const stale = await store.transition(id, 'submitted', 'verified', {}, 0, {
      actor: 'applicant',
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe('STALE_TRANSITION');
  });

  it('returns STALE_TRANSITION when fromState does not match', async () => {
    const created = await store.create(buildCreateRegistrationInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { id, version } = created.value;

    const wrong = await store.transition(id, 'verified', 'approved', {}, version, {
      actor: 'admin',
    });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error.code).toBe('STALE_TRANSITION');
  });

  it('applies patch fields alongside the transition', async () => {
    const created = await store.create(buildCreateRegistrationInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { id, version } = created.value;

    const result = await store.transition(
      id,
      'submitted',
      'verified',
      { verifiedAt: new Date('2026-01-02T00:00:00Z') },
      version,
      { actor: 'applicant' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verifiedAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('concurrent approve + reject: first wins, second gets STALE_TRANSITION', async () => {
    const created = await store.create(buildCreateRegistrationInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Advance to verified.
    const verified = await store.transition(created.value.id, 'submitted', 'verified', {}, 0, {
      actor: 'applicant',
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    // Both admin A and admin B read version=1 and try to decide.
    const [approve, reject] = await Promise.all([
      store.transition(verified.value.id, 'verified', 'approved', {}, 1, { actor: 'admin' }),
      store.transition(verified.value.id, 'verified', 'rejected', {}, 1, { actor: 'admin' }),
    ]);

    const results = [approve, reject];
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    if (!failures[0]!.ok) {
      expect(failures[0]!.error.code).toBe('STALE_TRANSITION');
    }
  });
});

describe('listNonTerminal', () => {
  it('returns only non-terminal registrations', async () => {
    await store.create(
      buildCreateRegistrationInput({
        idempotencyKey: 'key-1',
        contactEmail: 'a@x.com',
        contactPhone: '+911111111111',
      }),
    );
    const r2 = await store.create(
      buildCreateRegistrationInput({
        idempotencyKey: 'key-2',
        contactEmail: 'b@x.com',
        contactPhone: '+912222222222',
      }),
    );
    if (!r2.ok) return;

    // Reject r2.
    await store.transition(r2.value.id, 'submitted', 'rejected', {}, 0, { actor: 'admin' });

    const list = await store.listNonTerminal();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(1);
    expect(list.value[0]!.idempotencyKey).toBe('key-1');
  });
});

describe('markProjection', () => {
  it('sets a provision_state key', async () => {
    const created = await store.create(buildCreateRegistrationInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await store.markProjection(created.value.id, 'verification', 'done');

    const loaded = await store.findById(created.value.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value?.provisionState?.verification).toBe('done');
  });

  it('returns NOT_FOUND for unknown id', async () => {
    const result = await store.markProjection(
      '00000000-0000-0000-0000-nonexistent',
      'kc_user',
      'failed',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

describe('listFlaggedForReconcile', () => {
  it('returns only rows with failed provision steps', async () => {
    const r1 = await store.create(
      buildCreateRegistrationInput({
        idempotencyKey: 'key-1',
        contactEmail: 'a@x.com',
        contactPhone: '+911111111111',
      }),
    );
    const r2 = await store.create(
      buildCreateRegistrationInput({
        idempotencyKey: 'key-2',
        contactEmail: 'b@x.com',
        contactPhone: '+912222222222',
      }),
    );
    if (!r1.ok || !r2.ok) return;

    await store.markProjection(r1.value.id, 'verification', 'done');
    await store.markProjection(r2.value.id, 'admin_notify', 'failed');

    const flagged = await store.listFlaggedForReconcile();
    expect(flagged.ok).toBe(true);
    if (!flagged.ok) return;
    expect(flagged.value).toHaveLength(1);
    expect(flagged.value[0]!.id).toBe(r2.value.id);
  });
});
