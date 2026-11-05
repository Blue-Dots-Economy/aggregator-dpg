/**
 * Session storage contract for the aggregator portal BFF.
 *
 * Redis and in-memory implementations extend this base. Portal code depends
 * only on this abstract class.
 */

import { z } from 'zod';
import { MeResponseSchema } from '@aggregator-dpg/shared-primitives/user-org';

/**
 * The signed-in actor (`GET /v1/user/read/me`), cached briefly in the session.
 *
 * The database stays the authority; the cache saves one call per page.
 */
export const CachedActorSchema = z.object({
  me: MeResponseSchema,
  /** Epoch ms when it was read. */
  at: z.number(),
});
export type CachedActor = z.infer<typeof CachedActorSchema>;

/**
 * A stored session. An unreadable `consoleActor` cache is dropped, because the
 * console reads the actor again when the cache is absent.
 */
export const SessionDataSchema = z.object({
  sub: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  name: z.string().optional(),
  accessToken: z.string(),
  refreshToken: z.string(),
  idToken: z.string(),
  accessTokenExp: z.number(),
  refreshTokenExp: z.number(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  /** Console actor cache; absent until the console reads it. */
  consoleActor: CachedActorSchema.optional().catch(undefined),
});
export type SessionData = z.infer<typeof SessionDataSchema>;

export type SessionResult<T> = { ok: true; value: T } | { ok: false; error: SessionError };

export type SessionError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'STORE_UNAVAILABLE'; message: string }
  | { code: 'CORRUPT'; message: string };

/**
 * Abstract base for any session store. BFF code uses only this class.
 */
export abstract class SessionStoreBase {
  abstract create(data: SessionData): Promise<string>;
  abstract get(sid: string): Promise<SessionResult<SessionData>>;
  abstract update(sid: string, patch: Partial<SessionData>): Promise<SessionResult<void>>;
  abstract destroy(sid: string): Promise<void>;
  abstract close(): Promise<void>;
}
