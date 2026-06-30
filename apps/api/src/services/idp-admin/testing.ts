/**
 * Process-local fake IdP admin adapter. Used by tests so they never hit a
 * real Keycloak — the same call surface, in-memory user table.
 */

import { randomUUID } from 'node:crypto';
import {
  IdpAdminAdapter,
  type CreateUserInput,
  type IdpResult,
  type IdpUser,
} from './interface.js';
import { KC_ATTR } from './attributes.js';

export class IdpAdminFake extends IdpAdminAdapter {
  private users = new Map<string, IdpUser & { attributes: Record<string, string[]> }>();
  private groups = new Map<
    string,
    { id: string; name: string; attributes?: Record<string, string | string[]> }
  >();
  private memberships = new Map<string, Set<string>>(); // userId -> groupIds
  private roles = new Map<string, Set<string>>(); // userId -> realm roles
  private failNext: {
    code: 'AUTH_FAILED' | 'IDP_UNAVAILABLE' | 'BAD_REQUEST';
    message: string;
  } | null = null;

  /** Force the next operation (any) to fail. */
  failOnce(error: {
    code: 'AUTH_FAILED' | 'IDP_UNAVAILABLE' | 'BAD_REQUEST';
    message: string;
  }): void {
    this.failNext = error;
  }

  /** Test helper — wipes the user table + group/role state. */
  _reset(): void {
    this.users.clear();
    this.groups.clear();
    this.memberships.clear();
    this.roles.clear();
    this.failNext = null;
  }

  /** Test inspector — group ids a user belongs to. */
  groupsOf(userId: string): string[] {
    return [...(this.memberships.get(userId) ?? [])];
  }

  /** Test inspector — realm roles assigned to a user. */
  rolesOf(userId: string): string[] {
    return [...(this.roles.get(userId) ?? [])];
  }

  async createUser(input: CreateUserInput): Promise<IdpResult<IdpUser>> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      return { ok: false, error: e };
    }
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === input.email.toLowerCase()) {
        return {
          ok: false,
          error: { code: 'USER_EXISTS', message: 'email already in use' },
        };
      }
    }
    const id = randomUUID();
    const attrs: Record<string, string[]> = {};
    if (input.phone) attrs.phoneNumber = [input.phone];
    for (const [k, v] of Object.entries(input.attributes ?? {})) {
      attrs[k] = Array.isArray(v) ? v : [v];
    }
    const user: IdpUser & { attributes: Record<string, string[]> } = {
      id,
      email: input.email,
      username: input.username ?? input.email,
      enabled: input.enabled ?? true,
      ...(input.firstName ? { firstName: input.firstName } : {}),
      ...(input.lastName ? { lastName: input.lastName } : {}),
      attributes: attrs,
    };
    this.users.set(id, user);
    return { ok: true, value: user };
  }

  async findByEmail(email: string): Promise<IdpResult<IdpUser | null>> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      return { ok: false, error: e };
    }
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === email.toLowerCase()) return { ok: true, value: u };
    }
    return { ok: true, value: null };
  }

  async findById(userId: string): Promise<IdpResult<IdpUser | null>> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      return { ok: false, error: e };
    }
    return { ok: true, value: this.users.get(userId) ?? null };
  }

  async findByAttribute(name: string, value: string): Promise<IdpResult<IdpUser | null>> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      return { ok: false, error: e };
    }
    for (const u of this.users.values()) {
      const vals = u.attributes?.[name];
      if (Array.isArray(vals) && vals.includes(value)) return { ok: true, value: u };
    }
    return { ok: true, value: null };
  }

  async enableUser(userId: string): Promise<IdpResult<void>> {
    return this.setEnabled(userId, true);
  }

  async disableUser(userId: string): Promise<IdpResult<void>> {
    return this.setEnabled(userId, false);
  }

  async deleteUser(userId: string): Promise<IdpResult<void>> {
    if (!this.users.delete(userId)) {
      return { ok: false, error: { code: 'USER_NOT_FOUND', message: userId } };
    }
    return { ok: true, value: undefined };
  }

  async setAttributes(
    userId: string,
    attributes: Record<string, string | string[] | null>,
  ): Promise<IdpResult<void>> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      return { ok: false, error: e };
    }
    const u = this.users.get(userId);
    if (!u) {
      return { ok: false, error: { code: 'USER_NOT_FOUND', message: userId } };
    }
    const merged: Record<string, string[]> = { ...(u.attributes ?? {}) };
    for (const [k, v] of Object.entries(attributes)) {
      if (v === null) delete merged[k];
      else if (Array.isArray(v)) merged[k] = v;
      else merged[k] = [v];
    }
    u.attributes = merged;
    return { ok: true, value: undefined };
  }

  async setUserDecision(
    userId: string,
    decision: 'pending' | 'approved' | 'rejected',
  ): Promise<IdpResult<void>> {
    return this.setAttributes(userId, { [KC_ATTR.DECISION_MADE]: decision });
  }

  private setEnabled(userId: string, enabled: boolean): IdpResult<void> {
    const u = this.users.get(userId);
    if (!u) {
      return { ok: false, error: { code: 'USER_NOT_FOUND', message: userId } };
    }
    u.enabled = enabled;
    return { ok: true, value: undefined };
  }

  async createGroup(
    name: string,
    attributes?: Record<string, string | string[]>,
  ): Promise<IdpResult<{ id: string }>> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      return { ok: false, error: e };
    }
    const id = `grp-${this.groups.size + 1}`;
    this.groups.set(id, { id, name, ...(attributes ? { attributes } : {}) });
    return { ok: true, value: { id } };
  }

  async addUserToGroup(userId: string, groupId: string): Promise<IdpResult<void>> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      return { ok: false, error: e };
    }
    if (!this.users.has(userId)) {
      return { ok: false, error: { code: 'USER_NOT_FOUND', message: userId } };
    }
    if (!this.groups.has(groupId)) {
      return { ok: false, error: { code: 'BAD_REQUEST', message: `no such group: ${groupId}` } };
    }
    const set = this.memberships.get(userId) ?? new Set<string>();
    set.add(groupId);
    this.memberships.set(userId, set);
    return { ok: true, value: undefined };
  }

  async assignRealmRole(userId: string, role: string): Promise<IdpResult<void>> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      return { ok: false, error: e };
    }
    if (!this.users.has(userId)) {
      return { ok: false, error: { code: 'USER_NOT_FOUND', message: userId } };
    }
    const set = this.roles.get(userId) ?? new Set<string>();
    set.add(role);
    this.roles.set(userId, set);
    return { ok: true, value: undefined };
  }
}
