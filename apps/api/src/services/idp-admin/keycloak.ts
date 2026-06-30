/**
 * Keycloak adapter for the IdP admin port.
 *
 * Talks to Keycloak's admin REST API (`/admin/realms/{realm}/...`) using a
 * confidential service-account client (`aggregator-api`) granted only the
 * `realm-management:manage-users` role. Tokens are fetched via the
 * client_credentials grant and cached until ~30s before expiry.
 *
 * Maintained as a thin layer — every method maps to one or two REST calls;
 * no SDK in the dependency graph (DPG-friendly: replace by writing a new
 * adapter, no SDK lock-in).
 */

import {
  IdpAdminAdapter,
  type CreateUserInput,
  type IdpResult,
  type IdpUser,
} from './interface.js';
import { KC_ATTR } from './attributes.js';

const HTTP_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_LEAD_MS = 30_000;

export interface KeycloakAdminOptions {
  baseUrl: string; // e.g. http://keycloak:8080
  realm: string; // e.g. aggregator
  clientId: string; // e.g. aggregator-api
  clientSecret: string;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class KeycloakIdpAdmin extends IdpAdminAdapter {
  private cachedToken: CachedToken | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: KeycloakAdminOptions) {
    super();
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async createUser(input: CreateUserInput): Promise<IdpResult<IdpUser>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

    const attributes = buildAttributes(input);
    const payload = {
      username: input.username ?? input.email,
      email: input.email,
      emailVerified: true,
      enabled: input.enabled ?? true,
      ...(input.firstName ? { firstName: input.firstName } : {}),
      ...(input.lastName ? { lastName: input.lastName } : {}),
      ...(input.requiredActions && input.requiredActions.length > 0
        ? { requiredActions: input.requiredActions }
        : {}),
      attributes,
    };

    const url = `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users`;
    const res = await this.safeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenResult.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return res;

    if (res.value.status === 409) {
      return { ok: false, error: { code: 'USER_EXISTS', message: 'email already in use' } };
    }
    if (res.value.status !== 201) {
      const text = await res.value.text().catch(() => '');
      return {
        ok: false,
        error: {
          code: 'BAD_REQUEST',
          message: `createUser HTTP ${res.value.status}: ${text.slice(0, 200)}`,
        },
      };
    }

    // Keycloak returns the new user's URL in the Location header. Re-fetch
    // to get the full representation.
    const location = res.value.headers.get('location');
    const userId = location?.split('/').pop();
    if (!userId) {
      return {
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: 'no Location header on create' },
      };
    }
    return this.readUser(userId, tokenResult.value);
  }

  async findByEmail(email: string): Promise<IdpResult<IdpUser | null>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

    const url = new URL(`${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users`);
    url.searchParams.set('email', email);
    url.searchParams.set('exact', 'true');
    url.searchParams.set('max', '1');

    const res = await this.safeFetch(url.toString(), {
      headers: { Authorization: `Bearer ${tokenResult.value}` },
    });
    if (!res.ok) return res;

    if (!res.value.ok) {
      return {
        ok: false,
        error: {
          code: 'IDP_UNAVAILABLE',
          message: `findByEmail HTTP ${res.value.status}`,
        },
      };
    }
    const list = (await res.value.json()) as KcUserPayload[];
    const u = list[0];
    if (!u) return { ok: true, value: null };
    return { ok: true, value: toIdpUser(u, { fallbackEmail: email }) };
  }

  async findById(userId: string): Promise<IdpResult<IdpUser | null>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

    const res = await this.safeFetch(
      `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users/${userId}`,
      { headers: { Authorization: `Bearer ${tokenResult.value}` } },
    );
    if (!res.ok) return res;
    if (res.value.status === 404) return { ok: true, value: null };
    if (!res.value.ok) {
      return {
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: `findById HTTP ${res.value.status}` },
      };
    }
    const u = (await res.value.json()) as KcUserPayload;
    return { ok: true, value: toIdpUser(u) };
  }

  async findByAttribute(name: string, value: string): Promise<IdpResult<IdpUser | null>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

    const url = new URL(`${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users`);
    // Keycloak 22+ supports attribute search via `q=name:value`.
    url.searchParams.set('q', `${name}:${value}`);
    url.searchParams.set('briefRepresentation', 'false');
    url.searchParams.set('max', '2');

    const res = await this.safeFetch(url.toString(), {
      headers: { Authorization: `Bearer ${tokenResult.value}` },
    });
    if (!res.ok) return res;
    if (!res.value.ok) {
      return {
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: `findByAttribute HTTP ${res.value.status}` },
      };
    }
    const list = (await res.value.json()) as KcUserPayload[];
    // Defensive filter — Keycloak's q param matches partial values in some
    // versions, so post-filter for an exact match on the attribute value.
    const exact = list.find((u) => {
      const vals = u.attributes?.[name];
      return Array.isArray(vals) && vals.includes(value);
    });
    if (!exact) return { ok: true, value: null };
    return { ok: true, value: toIdpUser(exact) };
  }

  async enableUser(userId: string): Promise<IdpResult<void>> {
    return this.setEnabled(userId, true);
  }

  async disableUser(userId: string): Promise<IdpResult<void>> {
    return this.setEnabled(userId, false);
  }

  async deleteUser(userId: string): Promise<IdpResult<void>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

    const res = await this.safeFetch(
      `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users/${userId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenResult.value}` },
      },
    );
    if (!res.ok) return res;
    if (res.value.status === 404) {
      return { ok: false, error: { code: 'USER_NOT_FOUND', message: userId } };
    }
    if (res.value.status !== 204) {
      return {
        ok: false,
        error: {
          code: 'IDP_UNAVAILABLE',
          message: `deleteUser HTTP ${res.value.status}`,
        },
      };
    }
    return { ok: true, value: undefined };
  }

  async setAttributes(
    userId: string,
    attributes: Record<string, string | string[] | null>,
  ): Promise<IdpResult<void>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

    // Read existing user representation so we can merge — Keycloak's
    // `PUT /users/{id}` replaces the full `attributes` block, so partial
    // writes need a read-modify-write cycle.
    const current = await this.readUser(userId, tokenResult.value);
    if (!current.ok) return current;

    const merged: Record<string, string[]> = { ...(current.value.attributes ?? {}) };
    for (const [k, v] of Object.entries(attributes)) {
      if (v === null) {
        delete merged[k];
      } else if (Array.isArray(v)) {
        merged[k] = v;
      } else {
        merged[k] = [v];
      }
    }

    // Some Keycloak versions interpret an admin PUT that omits top-level
    // fields (email, username, firstName, lastName) as "clear those
    // fields". To stay safe across versions, write back the full user
    // representation we just read, with the merged attributes layered on.
    const u = current.value;
    const fullPayload: Record<string, unknown> = {
      id: u.id,
      username: u.username,
      email: u.email,
      enabled: u.enabled,
      attributes: merged,
    };
    if (u.firstName !== undefined) fullPayload.firstName = u.firstName;
    if (u.lastName !== undefined) fullPayload.lastName = u.lastName;

    const res = await this.safeFetch(
      `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users/${userId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokenResult.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(fullPayload),
      },
    );
    if (!res.ok) return res;
    if (res.value.status === 404) {
      return { ok: false, error: { code: 'USER_NOT_FOUND', message: userId } };
    }
    if (res.value.status !== 204) {
      return {
        ok: false,
        error: {
          code: 'IDP_UNAVAILABLE',
          message: `setAttributes HTTP ${res.value.status}`,
        },
      };
    }
    return { ok: true, value: undefined };
  }

  async setUserDecision(
    userId: string,
    decision: 'pending' | 'approved' | 'rejected',
  ): Promise<IdpResult<void>> {
    return this.setAttributes(userId, { [KC_ATTR.DECISION_MADE]: decision });
  }

  async createGroup(
    name: string,
    attributes?: Record<string, string | string[]>,
  ): Promise<IdpResult<{ id: string }>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

    // Keycloak group attributes are always string[]; coerce scalars.
    const kcAttributes: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(attributes ?? {})) {
      kcAttributes[k] = Array.isArray(v) ? v : [v];
    }

    const url = `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/groups`;
    const res = await this.safeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenResult.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, attributes: kcAttributes }),
    });
    if (!res.ok) return res;
    if (res.value.status !== 201) {
      const text = await res.value.text().catch(() => '');
      return {
        ok: false,
        error: {
          code: res.value.status === 409 ? 'BAD_REQUEST' : 'IDP_UNAVAILABLE',
          message: `createGroup HTTP ${res.value.status}: ${text.slice(0, 200)}`,
        },
      };
    }
    // Keycloak returns the new group's URL in the Location header.
    const location = res.value.headers.get('location');
    const groupId = location?.split('/').pop();
    if (!groupId) {
      return {
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: 'no Location header on group create' },
      };
    }
    return { ok: true, value: { id: groupId } };
  }

  async addUserToGroup(userId: string, groupId: string): Promise<IdpResult<void>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

    const url = `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users/${userId}/groups/${groupId}`;
    const res = await this.safeFetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenResult.value}` },
    });
    if (!res.ok) return res;
    if (res.value.status === 404) {
      return { ok: false, error: { code: 'USER_NOT_FOUND', message: `${userId}/${groupId}` } };
    }
    if (!res.value.ok) {
      return {
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: `addUserToGroup HTTP ${res.value.status}` },
      };
    }
    return { ok: true, value: undefined };
  }

  async assignRealmRole(userId: string, role: string): Promise<IdpResult<void>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

    // Resolve the realm-role representation first — the role-mappings endpoint
    // requires the full {id,name} object, not just the role name.
    const roleRes = await this.safeFetch(
      `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/roles/${encodeURIComponent(role)}`,
      { headers: { Authorization: `Bearer ${tokenResult.value}` } },
    );
    if (!roleRes.ok) return roleRes;
    if (!roleRes.value.ok) {
      return {
        ok: false,
        error: {
          code: roleRes.value.status === 404 ? 'BAD_REQUEST' : 'IDP_UNAVAILABLE',
          message: `assignRealmRole role lookup HTTP ${roleRes.value.status}`,
        },
      };
    }
    const roleRep = (await roleRes.value.json()) as { id: string; name: string };

    const mapRes = await this.safeFetch(
      `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users/${userId}/role-mappings/realm`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenResult.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ id: roleRep.id, name: roleRep.name }]),
      },
    );
    if (!mapRes.ok) return mapRes;
    if (mapRes.value.status === 404) {
      return { ok: false, error: { code: 'USER_NOT_FOUND', message: userId } };
    }
    if (!mapRes.value.ok) {
      return {
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: `assignRealmRole HTTP ${mapRes.value.status}` },
      };
    }
    return { ok: true, value: undefined };
  }

  // ─── private ───────────────────────────────────────────────────────────────

  private async setEnabled(userId: string, enabled: boolean): Promise<IdpResult<void>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

    const res = await this.safeFetch(
      `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users/${userId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokenResult.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled }),
      },
    );
    if (!res.ok) return res;
    if (res.value.status === 404) {
      return { ok: false, error: { code: 'USER_NOT_FOUND', message: userId } };
    }
    if (res.value.status !== 204) {
      return {
        ok: false,
        error: {
          code: 'IDP_UNAVAILABLE',
          message: `setEnabled HTTP ${res.value.status}`,
        },
      };
    }
    return { ok: true, value: undefined };
  }

  private async readUser(userId: string, accessToken: string): Promise<IdpResult<IdpUser>> {
    const res = await this.safeFetch(
      `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users/${userId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return res;
    if (!res.value.ok) {
      return {
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: `readUser HTTP ${res.value.status}` },
      };
    }
    const u = (await res.value.json()) as KcUserPayload;
    return { ok: true, value: toIdpUser(u) };
  }

  private async getToken(): Promise<IdpResult<string>> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - TOKEN_REFRESH_LEAD_MS) {
      return { ok: true, value: this.cachedToken.accessToken };
    }
    const params = new URLSearchParams();
    params.set('grant_type', 'client_credentials');
    params.set('client_id', this.opts.clientId);
    params.set('client_secret', this.opts.clientSecret);

    const res = await this.safeFetch(
      `${this.opts.baseUrl}/realms/${this.opts.realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
    );
    if (!res.ok) return res;
    if (!res.value.ok) {
      return {
        ok: false,
        error: { code: 'AUTH_FAILED', message: `token HTTP ${res.value.status}` },
      };
    }
    const body = (await res.value.json()) as { access_token: string; expires_in: number };
    this.cachedToken = {
      accessToken: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    return { ok: true, value: body.access_token };
  }

  /** Wraps `fetch` with a timeout and converts thrown errors to Result. */
  private async safeFetch(url: string, init: RequestInit): Promise<IdpResult<Response>> {
    try {
      const res = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      return { ok: true, value: res };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'IDP_UNAVAILABLE',
          message: err instanceof Error ? err.message : 'fetch failed',
        },
      };
    }
  }
}

function buildAttributes(input: CreateUserInput): Record<string, string[]> {
  const attrs: Record<string, string[]> = {};
  if (input.phone) attrs.phoneNumber = [input.phone];
  for (const [k, v] of Object.entries(input.attributes ?? {})) {
    attrs[k] = Array.isArray(v) ? v : [v];
  }
  return attrs;
}

interface KcUserPayload {
  id: string;
  username: string;
  email?: string;
  enabled?: boolean;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, string[]>;
}

function toIdpUser(u: KcUserPayload, opts: { fallbackEmail?: string } = {}): IdpUser {
  return {
    id: u.id,
    email: u.email ?? opts.fallbackEmail ?? '',
    username: u.username,
    enabled: u.enabled ?? false,
    ...(u.firstName ? { firstName: u.firstName } : {}),
    ...(u.lastName ? { lastName: u.lastName } : {}),
    ...(u.attributes ? { attributes: u.attributes } : {}),
  };
}
