/**
 * In-memory session store. Dev/test fallback when Redis is unavailable.
 *
 * Not safe for multi-process deployments — every Node instance has its own
 * Map, so sessions created on one will not be visible on another.
 */

import { randomUUID } from 'node:crypto';
import { SessionStoreBase, type SessionData, type SessionResult } from './interface';

interface Entry {
  data: SessionData;
  expiresAt: number;
}

export interface MemorySessionStoreOptions {
  ttlSec?: number;
}

/**
 * Process-local session store backed by a Map. Honours sliding TTL.
 */
export class MemorySessionStore extends SessionStoreBase {
  private readonly store = new Map<string, Entry>();
  private readonly ttlSec: number;

  constructor(opts: MemorySessionStoreOptions = {}) {
    super();
    this.ttlSec = opts.ttlSec ?? 60 * 60 * 12;
  }

  async create(data: SessionData): Promise<string> {
    const sid = randomUUID();
    this.store.set(sid, {
      data,
      expiresAt: Date.now() + this.ttlSec * 1000,
    });
    return sid;
  }

  async get(sid: string): Promise<SessionResult<SessionData>> {
    if (!sid) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'empty sid' } };
    }
    const entry = this.store.get(sid);
    if (!entry) {
      return {
        ok: false,
        error: { code: 'NOT_FOUND', message: `session ${sid} not found` },
      };
    }
    if (entry.expiresAt < Date.now()) {
      this.store.delete(sid);
      return {
        ok: false,
        error: { code: 'NOT_FOUND', message: `session ${sid} expired` },
      };
    }
    entry.expiresAt = Date.now() + this.ttlSec * 1000;
    return { ok: true, value: entry.data };
  }

  async update(sid: string, patch: Partial<SessionData>): Promise<SessionResult<void>> {
    const entry = this.store.get(sid);
    if (!entry) {
      return {
        ok: false,
        error: { code: 'NOT_FOUND', message: `session ${sid} not found` },
      };
    }
    entry.data = { ...entry.data, ...patch, lastSeenAt: Date.now() };
    entry.expiresAt = Date.now() + this.ttlSec * 1000;
    return { ok: true, value: undefined };
  }

  async destroy(sid: string): Promise<void> {
    this.store.delete(sid);
  }

  async close(): Promise<void> {
    this.store.clear();
  }

  /** Test helper — wipes the store. */
  _reset(): void {
    this.store.clear();
  }
}
