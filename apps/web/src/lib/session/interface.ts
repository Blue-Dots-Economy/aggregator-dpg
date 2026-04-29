/**
 * Session storage contract for the aggregator portal BFF.
 *
 * Concrete implementations (Redis, in-memory) extend this base. The portal
 * depends only on this abstract surface so the storage backend stays swappable.
 */

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
