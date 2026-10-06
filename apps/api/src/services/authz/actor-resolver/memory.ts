/**
 * In-memory actor resolver (`@aggregator-dpg/api`). For unit tests.
 */

import {
  ActorResolverBase,
  type ActorResolverResult,
  type ResolvedActor,
  type TokenIdentity,
} from './interface.js';

/** Map-backed {@link ActorResolverBase}. */
export class InMemoryActorResolver extends ActorResolverBase {
  private readonly byId = new Map<string, ResolvedActor>();
  private readonly bySubject = new Map<string, string>();
  private readonly parents = new Map<string, string>();

  /**
   * Adds an actor, optionally reachable by subject.
   *
   * @param actor - The actor.
   * @param subject - Keycloak `sub` that resolves to it.
   */
  seed(actor: ResolvedActor, subject?: string): void {
    this.byId.set(actor.userId, actor);
    if (subject) this.bySubject.set(subject, actor.userId);
  }

  /**
   * Records an organisation's parent.
   *
   * @param orgId - The child.
   * @param parentId - Its parent.
   */
  seedParent(orgId: string, parentId: string): void {
    this.parents.set(orgId, parentId);
  }

  /** {@inheritDoc ActorResolverBase.resolve} */
  async resolve(identity: TokenIdentity): Promise<ActorResolverResult<ResolvedActor | null>> {
    const id = identity.aggregatorId ?? this.bySubject.get(identity.subject);
    return { ok: true, value: (id && this.byId.get(id)) || null };
  }

  /** {@inheritDoc ActorResolverBase.orgChain} */
  async orgChain(orgId: string): Promise<ActorResolverResult<string[]>> {
    const chain = [orgId];
    let current = this.parents.get(orgId);
    while (current && !chain.includes(current)) {
      chain.push(current);
      current = this.parents.get(current);
    }
    return { ok: true, value: chain };
  }
}
