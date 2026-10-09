/**
 * Test fake and builders for the decision engine (`@aggregator-dpg/rbac`).
 *
 * `AuthorizerFake` evaluates the real rules in-process and records every
 * question it was asked, so tests can assert on the inputs. Use
 * `failWith()` to simulate an unreachable engine.
 *
 * @module @aggregator-dpg/rbac/testing
 */

import { err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { InMemoryAuthorizer } from '../in-memory/index.js';
import type {
  Actor,
  ActorOrg,
  Capability,
  CapabilityListInput,
  Decision,
  DecisionInput,
} from '../interface.js';

/** In-process engine that records its inputs and can be made to fail. */
export class AuthorizerFake extends InMemoryAuthorizer {
  /** Every input passed to `decide`, in order. */
  readonly calls: DecisionInput[] = [];
  private failure: BaseError | null = null;

  /**
   * Makes every following call fail with `error` (default: `OPA_UNAVAILABLE`).
   *
   * @param error - The error to return.
   */
  failWith(error: BaseError = new UpstreamError('fake outage', { code: 'OPA_UNAVAILABLE' })): void {
    this.failure = error;
  }

  /**
   * Records the input, then answers it (or fails, after `failWith`).
   *
   * @param input - The access question.
   * @returns The decision, or the configured failure.
   */
  override async decide(input: DecisionInput): Promise<Result<Decision, BaseError>> {
    this.calls.push(input);
    if (this.failure) return err(this.failure);
    return super.decide(input);
  }

  /**
   * Answers a capability list (or fails, after `failWith`).
   *
   * @param input - The actor, the candidates and the current time.
   * @returns The held capabilities, or the configured failure.
   */
  override async listCapabilities(
    input: CapabilityListInput,
  ): Promise<Result<Capability[], BaseError>> {
    if (this.failure) return err(this.failure);
    return super.listCapabilities(input);
  }
}

/**
 * Builds an organisation entry for an actor.
 *
 * @param overrides - Fields to change from the defaults.
 * @returns An aggregator organisation the actor coordinates in.
 */
export function buildActorOrg(overrides: Partial<ActorOrg> = {}): ActorOrg {
  return {
    id: 'org-a',
    orgType: 'aggregator',
    relation: 'member',
    capabilities: ['profiles.view', 'profiles.onboard'],
    ...overrides,
  };
}

/**
 * Builds an active coordinator actor.
 *
 * @param overrides - Fields to change from the defaults.
 * @returns A fully-formed actor.
 */
export function buildActor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'user-coord',
    userType: 'coordinator',
    active: true,
    roleCapabilities: ['profiles.view', 'profiles.onboard'],
    orgs: [buildActorOrg()],
    grants: [],
    ...overrides,
  };
}
