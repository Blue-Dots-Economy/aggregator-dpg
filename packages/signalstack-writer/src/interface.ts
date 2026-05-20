/**
 * SignalStack writer contract — single boundary for every aggregator path that
 * pushes a participant + optional profile to a signalstack instance through
 * `POST /api/v1/admin/onboard`.
 *
 * The local `participants` table is written by `@aggregator-dpg/participants-writer`.
 * This writer is the parallel "outward" wrapper: every place that decides a
 * participant should be reflected into signalstack calls this single method.
 *
 * Every method returns Result<T, BaseError> — never throws.
 */

import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

/**
 * User identity payload. At least one of `email` / `phoneNumber` is required;
 * the writer impl is responsible for enforcing that before dispatch.
 */
export interface SignalStackUserInput {
  name: string;
  email?: string | null;
  phoneNumber?: string | null;
}

/**
 * Profile payload. `item_id` switches the route into update mode; omitting it
 * creates a new profile under the resolved user.
 */
export interface SignalStackProfileInput {
  item_id?: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state?: Record<string, unknown>;
  item_latitude?: number | null;
  item_longitude?: number | null;
}

/**
 * Input for one onboard call.
 *
 * `aggregator_id` is set once on profile create and is immutable thereafter
 * (signalstack ignores it on update). Pass undefined for non-aggregator
 * call sites (e.g., if this writer is ever reused by the UI path).
 */
export interface SignalStackOnboardInput {
  user: SignalStackUserInput;
  profile?: SignalStackProfileInput;
  aggregator_id?: string;
}

/**
 * Echo of the user row resolved by signalstack — same row whether created or
 * found by phone/email lookup.
 */
export interface SignalStackUser {
  id: string;
  name: string;
  email: string | null;
  phoneNumber: string | null;
  role: string | null;
}

/**
 * Echo of one profile row stored in signalstack's `items` table. The full
 * list of profiles owned by the resolved user is returned on every call.
 */
export interface SignalStackProfile {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, unknown>;
  item_latitude: number | null;
  item_longitude: number | null;
  aggregator_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Status flags returned by signalstack so the caller can attribute the
 * outcome without an extra round-trip.
 */
export interface SignalStackOnboardStatus {
  userCreated: boolean;
  userExisted: boolean;
  profileCreated: boolean;
  profileUpdated: boolean;
  profileExisted: boolean;
}

/**
 * Full signalstack response payload. `profiles` always contains every profile
 * the resolved user owns, not just the one this call wrote / updated.
 */
export interface SignalStackOnboardResult {
  user: SignalStackUser;
  profiles: SignalStackProfile[];
  status: SignalStackOnboardStatus;
}

/**
 * Persistence port for the signalstack onboard call.
 *
 * Implementations:
 *   - Http: real `POST /api/v1/admin/onboard` impl using fetch.
 *   - InMemory: deterministic Map-backed impl for unit tests.
 *   - Fake: in-memory + `seed()` helper for cross-package consumer tests.
 */
export abstract class SignalStackWriterBase {
  /**
   * Push one onboard event to signalstack.
   *
   * @param input - User identifier + optional profile + optional aggregator_id.
   * @returns ok(SignalStackOnboardResult) on 2xx; err(BaseError) on transport
   *   failure, validation rejection, or any non-2xx response.
   */
  abstract onboard(
    input: SignalStackOnboardInput,
  ): Promise<Result<SignalStackOnboardResult, BaseError>>;
}
