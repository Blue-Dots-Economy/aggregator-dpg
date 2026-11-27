/**
 * Redis-backed session store.
 *
 * Stores each session under `session:<sid>` with a sliding TTL that each
 * `get` refreshes.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import {
  SessionDataSchema,
  SessionStoreBase,
  type SessionData,
  type SessionResult,
} from './interface';
import { getRedisClient } from './redis-client';
import { logger } from '../logger';

const KEY_PREFIX = 'session:';
const SIGN_IN_PREFIX = 'signin:';
/** IdP session id → the ids of the portal sessions created under it. */
const IDP_SESSION_PREFIX = 'sessionidp:';

/** Hashed so a key listing does not reveal IdP session ids. */
function idpIndexKey(idpSid: string): string {
  return IDP_SESSION_PREFIX + createHash('sha256').update(idpSid).digest('hex');
}

/** `state` is a credential for its sign-in, so keys hold only its hash. */
function signInKey(state: string): string {
  return SIGN_IN_PREFIX + createHash('sha256').update(state).digest('hex');
}

export interface RedisSessionStoreOptions {
  /** Sliding TTL in seconds (default 12h). */
  ttlSec?: number;
  /** Inject a Redis client (for tests); defaults to shared singleton. */
  client?: Redis;
}

/**
 * Persists session state in Redis keyed by an opaque session ID.
 */
export class RedisSessionStore extends SessionStoreBase {
  private readonly redis: Redis;
  private readonly ttlSec: number;

  constructor(opts: RedisSessionStoreOptions = {}) {
    super();
    this.redis = opts.client ?? getRedisClient();
    this.ttlSec = opts.ttlSec ?? 60 * 60 * 12;
  }

  /**
   * Persists a new session and returns its opaque ID.
   *
   * @param data - Full session payload (tokens + claims).
   * @returns Newly generated session ID (UUID v4).
   */
  async create(data: SessionData): Promise<string> {
    const sid = randomUUID();
    await this.redis.set(KEY_PREFIX + sid, JSON.stringify(data), 'EX', this.ttlSec);
    if (data.idpSid) {
      const index = idpIndexKey(data.idpSid);
      await this.redis.sadd(index, sid);
      await this.redis.expire(index, this.ttlSec);
    }
    return sid;
  }

  /**
   * Loads a session and slides its TTL forward.
   *
   * @param sid - Session ID from cookie.
   * @returns Session data or a structured error.
   */
  async get(sid: string): Promise<SessionResult<SessionData>> {
    if (!sid) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'empty sid' } };
    }
    let raw: string | null;
    try {
      raw = await this.redis.get(KEY_PREFIX + sid);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'STORE_UNAVAILABLE',
          message: err instanceof Error ? err.message : 'redis error',
        },
      };
    }
    if (!raw) {
      return {
        ok: false,
        error: { code: 'NOT_FOUND', message: `session ${sid} not found` },
      };
    }
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      return this.discardCorrupt(sid, 'unparseable');
    }
    const session = SessionDataSchema.safeParse(stored);
    if (!session.success) return this.discardCorrupt(sid, 'unexpected shape');
    const parsed = session.data;
    // Slide the TTL; failure is non-fatal. The IdP index slides with it, so it
    // outlives every session it lists.
    void this.redis.expire(KEY_PREFIX + sid, this.ttlSec);
    if (parsed.idpSid) void this.redis.expire(idpIndexKey(parsed.idpSid), this.ttlSec);
    return { ok: true, value: parsed };
  }

  /**
   * Deletes an unreadable session so it is not read again, and logs why.
   *
   * Never log the session id: it works as a login credential.
   *
   * @param sid - Session ID.
   * @param reason - Why the session could not be read.
   */
  private discardCorrupt(sid: string, reason: string): SessionResult<never> {
    logger.warn({ operation: 'session.get', status: 'failure', code: 'CORRUPT', reason });
    this.redis.del(KEY_PREFIX + sid).catch((err: unknown) => {
      logger.warn({
        operation: 'session.discard',
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return { ok: false, error: { code: 'CORRUPT', message: `session ${reason}` } };
  }

  /**
   * Merges a partial update into an existing session.
   *
   * @param sid - Session ID.
   * @param patch - Fields to overwrite.
   */
  async update(sid: string, patch: Partial<SessionData>): Promise<SessionResult<void>> {
    const existing = await this.get(sid);
    if (!existing.ok) return existing;
    const next: SessionData = {
      ...existing.value,
      ...patch,
      lastSeenAt: Date.now(),
    };
    await this.redis.set(KEY_PREFIX + sid, JSON.stringify(next), 'EX', this.ttlSec);
    return { ok: true, value: undefined };
  }

  /**
   * Removes a session. Idempotent — no error if the key is absent.
   *
   * @param sid - Session ID to delete.
   */
  async destroy(sid: string): Promise<void> {
    if (!sid) return;
    await this.redis.del(KEY_PREFIX + sid);
  }

  /**
   * No-op; the client is shared. Call `closeRedisClient()` on shutdown.
   */
  async close(): Promise<void> {
    /* shared client lifecycle is managed externally */
  }

  /**
   * Records a sign-in this portal started. A failure is logged, not thrown, so
   * Redis trouble never blocks a sign-in; the record is then simply missing.
   */
  async rememberSignIn(state: string, browser: string, ttlSec: number): Promise<void> {
    if (!state || !browser) return;
    try {
      await this.redis.set(signInKey(state), browser, 'EX', ttlSec);
    } catch (err) {
      logger.warn({
        operation: 'session.rememberSignIn',
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Removes the record of a sign-in this portal started. A failure counts as no
   * record, so the caller falls back to its safer path.
   */
  async takeSignIn(state: string): Promise<string | null> {
    if (!state) return null;
    try {
      return await this.redis.getdel(signInKey(state));
    } catch (err) {
      logger.warn({
        operation: 'session.takeSignIn',
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async destroyByIdpSession(idpSid: string): Promise<number> {
    const index = idpIndexKey(idpSid);
    const sids = await this.redis.smembers(index);
    await this.redis.del(...sids.map((sid) => KEY_PREFIX + sid), index);
    return sids.length;
  }
}
