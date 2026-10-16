/**
 * Session storage contract for the aggregator portal BFF.
 *
 * Concrete implementations (Redis, in-memory) extend this base. The portal
 * depends only on this abstract surface so the storage backend stays swappable.
 */

import type { MeResponse } from '@aggregator-dpg/shared-primitives/user-org';

/**
 * The signed-in actor (`GET /v1/user/read/me`) cached in the session for a
 * short time (user & org Phase 5, C14): the database stays the authority, so
 * the cache only spares a call per page.
 */
export interface CachedActor {
  me: MeResponse;
  /** Epoch ms when it was read. */
  at: number;
}

export interface SessionData {
  sub: string;
  email?: string;
  phone?: string;
  name?: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accessTokenExp: number;
  refreshTokenExp: number;
  createdAt: number;
  lastSeenAt: number;
  /** Console actor cache; absent until the console reads it. */
  consoleActor?: CachedActor;
}

export type SessionResult<T> = { ok: true; value: T } | { ok: false; error: SessionError };

export type SessionError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'STORE_UNAVAILABLE'; message: string }
  | { code: 'CORRUPT'; message: string };

/**
 * Abstract base for any session store. All BFF code talks to this surface only.
 */
export abstract class SessionStoreBase {
  abstract create(data: SessionData): Promise<string>;
  abstract get(sid: string): Promise<SessionResult<SessionData>>;
  abstract update(sid: string, patch: Partial<SessionData>): Promise<SessionResult<void>>;
  abstract destroy(sid: string): Promise<void>;
  abstract close(): Promise<void>;
}
