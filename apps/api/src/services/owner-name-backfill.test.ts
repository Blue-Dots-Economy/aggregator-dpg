import { describe, it, expect } from 'vitest';
import { IdpAdminFake } from './idp-admin/testing.js';
import { backfillOwnerContactNames, type OwnerNameCandidate } from './owner-name-backfill.js';
import type { IdpResult, IdpUser } from './idp-admin/interface.js';

/** Fake that answers `findById` from a scripted table. */
class ScriptedIdp extends IdpAdminFake {
  constructor(private readonly answers: Record<string, Array<IdpResult<IdpUser | null>>>) {
    super();
  }
  override async findById(userId: string): Promise<IdpResult<IdpUser | null>> {
    const queue = this.answers[userId] ?? [{ ok: true, value: null }];
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  }
}

const user = (over: Partial<IdpUser> = {}): IdpUser => ({
  id: 'kc-1',
  email: 'o@x.org',
  username: 'o@x.org',
  enabled: true,
  ...over,
});

function run(
  idp: ScriptedIdp,
  candidates: OwnerNameCandidate[],
  dryRun = false,
  existingNames: Record<string, string> = {},
) {
  const written: Record<string, string> = { ...existingNames };
  return backfillOwnerContactNames(
    {
      idp,
      listCandidates: async () => candidates,
      setNameIfMissing: async (id, name) => {
        if (written[id]) return false;
        written[id] = name;
        return true;
      },
      retryDelayMs: 0,
    },
    { dryRun },
  ).then((report) => ({ report, written }));
}

const cand = (n: number): OwnerNameCandidate => ({
  orgId: `org-${n}`,
  contactId: `c${n}`,
  ownerKcSub: `kc-${n}`,
});

describe('backfillOwnerContactNames', () => {
  it('writes first + last name from Keycloak', async () => {
    const idp = new ScriptedIdp({
      'kc-1': [{ ok: true, value: user({ firstName: 'Ravi', lastName: 'Kumar' }) }],
    });
    const { report, written } = await run(idp, [cand(1)]);
    expect(written).toEqual({ c1: 'Ravi Kumar' });
    expect(report).toMatchObject({ candidates: 1, updated: 1, failed: 0 });
  });

  it('dry-run counts but never writes', async () => {
    const idp = new ScriptedIdp({ 'kc-1': [{ ok: true, value: user({ firstName: 'Ravi' }) }] });
    const { report, written } = await run(idp, [cand(1)], true);
    expect(written).toEqual({});
    expect(report).toMatchObject({ updated: 1, dryRun: true });
  });

  it('keeps an existing name (idempotent re-run)', async () => {
    const idp = new ScriptedIdp({ 'kc-1': [{ ok: true, value: user({ firstName: 'New' }) }] });
    const { report, written } = await run(idp, [cand(1)], false, { c1: 'Existing' });
    expect(written).toEqual({ c1: 'Existing' });
    expect(report.updated).toBe(0);
  });

  it('skips a Keycloak user with no name, and a missing user', async () => {
    const idp = new ScriptedIdp({
      'kc-1': [{ ok: true, value: user({ firstName: '  ' }) }],
      'kc-2': [{ ok: true, value: null }],
    });
    const { report } = await run(idp, [cand(1), cand(2)]);
    expect(report).toMatchObject({ candidates: 2, updated: 0, noName: 1, userMissing: 1 });
  });

  it('retries a transient Keycloak failure once', async () => {
    const idp = new ScriptedIdp({
      'kc-1': [
        { ok: false, error: { code: 'IDP_UNAVAILABLE', message: 'timeout' } },
        { ok: true, value: user({ lastName: 'Only' }) },
      ],
    });
    const { report, written } = await run(idp, [cand(1)]);
    expect(written).toEqual({ c1: 'Only' });
    expect(report.failed).toBe(0);
  });

  it('counts a failure that persists after the retry', async () => {
    const down: IdpResult<IdpUser | null> = {
      ok: false,
      error: { code: 'IDP_UNAVAILABLE', message: 'down' },
    };
    const idp = new ScriptedIdp({ 'kc-1': [down, down] });
    const { report } = await run(idp, [cand(1)]);
    expect(report.failed).toBe(1);
  });

  it('handles an empty candidate list', async () => {
    const { report } = await run(new ScriptedIdp({}), []);
    expect(report).toMatchObject({ candidates: 0, updated: 0 });
  });
});
