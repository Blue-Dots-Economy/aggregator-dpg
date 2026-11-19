/**
 * In-memory identity store for tests (`@aggregator-dpg/api`). Same outcomes as
 * the Postgres adapter: one login per provider per account, one account per
 * type per external login, never overwritten.
 */

import { IdentityStoreBase, type IdentityStoreResult, type LinkOutcome } from './interface.js';

/** One stored link. */
export interface IdentityLink {
  userId: string;
  /** Defaults to `admin` when omitted. */
  userType?: AccountType;
  provider: string;
  subject: string;
}

type AccountType = 'admin' | 'coordinator';

function typeOf(l: IdentityLink): AccountType {
  return l.userType ?? 'admin';
}

/** In-memory {@link IdentityStoreBase}. */
export class InMemoryIdentityStore extends IdentityStoreBase {
  protected readonly links: IdentityLink[] = [];

  /** Known account types (optional; see {@link registerAccount}). */
  protected readonly accountTypes = new Map<string, AccountType>();

  /**
   * Test helper — declares an account and its type, so `userType` checks apply.
   * An undeclared account is stored as `userType` when given, else as an admin.
   */
  registerAccount(userId: string, type: 'admin' | 'coordinator'): void {
    this.accountTypes.set(userId, type);
  }

  link(
    userId: string,
    provider: string,
    subject: string,
    userType?: 'admin' | 'coordinator',
  ): Promise<IdentityStoreResult<LinkOutcome>> {
    const known = this.accountTypes.get(userId);
    if (userType && known && known !== userType) {
      return Promise.resolve({
        ok: false,
        error: { code: 'NOT_LINKABLE', message: 'wrong account type' },
      });
    }
    const mine = this.links.find((l) => l.userId === userId && l.provider === provider);
    if (mine) {
      return Promise.resolve(
        mine.subject === subject
          ? { ok: true, value: 'already' }
          : { ok: false, error: { code: 'MISMATCH', message: 'different subject' } },
      );
    }
    const type = known ?? userType ?? 'admin';
    if (
      this.links.some((l) => l.provider === provider && l.subject === subject && typeOf(l) === type)
    ) {
      return Promise.resolve({ ok: false, error: { code: 'DUPLICATE', message: 'subject taken' } });
    }
    this.links.push({ userId, userType: type, provider, subject });
    return Promise.resolve({ ok: true, value: 'linked' });
  }

  subjectOf(userId: string, provider: string): Promise<IdentityStoreResult<string | null>> {
    const l = this.links.find((x) => x.userId === userId && x.provider === provider);
    return Promise.resolve({ ok: true, value: l?.subject ?? null });
  }

  userOf(
    provider: string,
    subject: string,
    userType?: AccountType,
  ): Promise<IdentityStoreResult<string | null>> {
    const matches = this.links.filter((l) => l.provider === provider && l.subject === subject);
    const l = userType
      ? matches.find((x) => typeOf(x) === userType)
      : (matches.find((x) => typeOf(x) === 'admin') ?? matches[0]);
    return Promise.resolve({ ok: true, value: l?.userId ?? null });
  }

  accountsOf(
    provider: string,
    subject: string,
  ): Promise<IdentityStoreResult<{ admin: string | null; coordinator: string | null }>> {
    const matches = this.links.filter((l) => l.provider === provider && l.subject === subject);
    return Promise.resolve({
      ok: true,
      value: {
        admin: matches.find((x) => typeOf(x) === 'admin')?.userId ?? null,
        coordinator: matches.find((x) => typeOf(x) === 'coordinator')?.userId ?? null,
      },
    });
  }

  /** Test inspector — every stored link. */
  all(): IdentityLink[] {
    return [...this.links];
  }
}
