/**
 * Keycloak adapter for the IdP admin port.
 *
 * Part of `@aggregator-dpg/api`. Calls Keycloak's admin REST API
 * (`/admin/realms/{realm}/...`) with a confidential service-account client
 * (`aggregator-api`) that has only `realm-management:manage-users`. Tokens come
 * from the client_credentials grant and are cached until ~30s before expiry.
 *
 * Each method maps to one or two REST calls; no SDK is used.
 */

import { z } from 'zod';
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
  realm: string; // e.g. bluedots
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

    // Keycloak returns the new user's URL in Location; re-fetch the full record.
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
    const list = await readJson(res.value, z.array(KcUserSchema), 'findByEmail');
    if (!list.ok) return list;
    const u = list.value[0];
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
    const u = await readJson(res.value, KcUserSchema, 'findById');
    if (!u.ok) return u;
    return { ok: true, value: toIdpUser(u.value) };
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
    const list = await readJson(res.value, validEntries(KcUserSchema), 'findByAttribute');
    if (!list.ok) return list;
    // Some Keycloak versions match `q` partially; keep exact matches only.
    const exact = list.value.find((u) => {
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

    // `PUT /users/{id}` replaces all attributes, so read and merge first.
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

    // Write back the full user; some Keycloak versions clear omitted top-level fields.
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

    // `POST /groups` ignores `attributes`, so set them with `PUT /groups/{id}`.
    if (Object.keys(kcAttributes).length > 0) {
      const putUrl = `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/groups/${groupId}`;
      const putRes = await this.safeFetch(putUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokenResult.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, attributes: kcAttributes }),
      });
      if (!putRes.ok) return putRes;
      if (!putRes.value.ok) {
        const text = await putRes.value.text().catch(() => '');
        return {
          ok: false,
          error: {
            code: 'IDP_UNAVAILABLE',
            message: `createGroup set-attributes HTTP ${putRes.value.status}: ${text.slice(0, 200)}`,
          },
        };
      }
    }

    return { ok: true, value: { id: groupId } };
  }

  async deleteGroup(groupId: string): Promise<IdpResult<void>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

    const url = `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/groups/${groupId}`;
    const res = await this.safeFetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenResult.value}` },
    });
    if (!res.ok) return res;
    // 404 means already gone; treat as success.
    if (!res.value.ok && res.value.status !== 404) {
      return {
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: `deleteGroup HTTP ${res.value.status}` },
      };
    }
    return { ok: true, value: undefined };
  }

  async findGroupByName(
    name: string,
  ): Promise<IdpResult<{ id: string; attributes: Record<string, string[]> } | null>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;
    const url = `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/groups?search=${encodeURIComponent(name)}&exact=true&briefRepresentation=false`;
    const res = await this.safeFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenResult.value}` },
    });
    if (!res.ok) return res;
    if (!res.value.ok) {
      return {
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: `findGroupByName HTTP ${res.value.status}` },
      };
    }
    // A body that is not JSON or not a list reads as no match.
    const body: unknown = await res.value.json().catch(() => []);
    const groups = validEntries(KcGroupSchema).safeParse(body);
    const match = groups.success ? groups.data.find((g) => g.name === name && g.id) : undefined;
    return {
      ok: true,
      value: match ? { id: match.id, attributes: match.attributes ?? {} } : null,
    };
  }

  async removeUserFromGroup(userId: string, groupId: string): Promise<IdpResult<void>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;
    const url = `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users/${userId}/groups/${groupId}`;
    const res = await this.safeFetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenResult.value}` },
    });
    if (!res.ok) return res;
    if (!res.value.ok && res.value.status !== 404) {
      return {
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: `removeUserFromGroup HTTP ${res.value.status}` },
      };
    }
    return { ok: true, value: undefined };
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

    // The role-mappings endpoint needs the full {id,name} role object.
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
    const roleRep = await readJson(roleRes.value, KcRoleSchema, 'assignRealmRole');
    if (!roleRep.ok) return roleRep;

    const mapRes = await this.safeFetch(
      `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users/${userId}/role-mappings/realm`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenResult.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ id: roleRep.value.id, name: roleRep.value.name }]),
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

  async listRealmRoles(userId: string): Promise<IdpResult<string[]>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;
    const res = await this.safeFetch(
      `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users/${userId}/role-mappings/realm`,
      { headers: { Authorization: `Bearer ${tokenResult.value}` } },
    );
    if (!res.ok) return res;
    if (!res.value.ok) {
      return {
        ok: false,
        error: {
          code: res.value.status === 404 ? 'USER_NOT_FOUND' : 'IDP_UNAVAILABLE',
          message: `listRealmRoles HTTP ${res.value.status}`,
        },
      };
    }
    const roles = await readJson(res.value, validEntries(KcRoleNameSchema), 'listRealmRoles');
    if (!roles.ok) return roles;
    return { ok: true, value: roles.value.map((r) => r.name) };
  }

  async removeRealmRole(userId: string, role: string): Promise<IdpResult<void>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

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
          message: `removeRealmRole role lookup HTTP ${roleRes.value.status}`,
        },
      };
    }
    const roleRep = await readJson(roleRes.value, KcRoleSchema, 'removeRealmRole');
    if (!roleRep.ok) return roleRep;

    // DELETE on role-mappings is a no-op for a role the user does not hold.
    const mapRes = await this.safeFetch(
      `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users/${userId}/role-mappings/realm`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${tokenResult.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ id: roleRep.value.id, name: roleRep.value.name }]),
      },
    );
    if (!mapRes.ok) return mapRes;
    if (mapRes.value.status === 404) {
      return { ok: false, error: { code: 'USER_NOT_FOUND', message: userId } };
    }
    if (!mapRes.value.ok) {
      return {
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: `removeRealmRole HTTP ${mapRes.value.status}` },
      };
    }
    return { ok: true, value: undefined };
  }

  async logoutSessions(userId: string): Promise<IdpResult<void>> {
    const tokenResult = await this.getToken();
    if (!tokenResult.ok) return tokenResult;

    const res = await this.safeFetch(
      `${this.opts.baseUrl}/admin/realms/${this.opts.realm}/users/${userId}/logout`,
      { method: 'POST', headers: { Authorization: `Bearer ${tokenResult.value}` } },
    );
    if (!res.ok) return res;
    if (res.value.status === 404) {
      return { ok: false, error: { code: 'USER_NOT_FOUND', message: userId } };
    }
    if (!res.value.ok) {
      return {
        ok: false,
        error: { code: 'IDP_UNAVAILABLE', message: `logoutSessions HTTP ${res.value.status}` },
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
    const u = await readJson(res.value, KcUserSchema, 'readUser');
    if (!u.ok) return u;
    return { ok: true, value: toIdpUser(u.value) };
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
    const body = await readJson(res.value, KcTokenSchema, 'getToken');
    if (!body.ok) return { ok: false, error: { code: 'AUTH_FAILED', message: body.error.message } };
    this.cachedToken = {
      accessToken: body.value.access_token,
      expiresAt: Date.now() + body.value.expires_in * 1000,
    };
    return { ok: true, value: body.value.access_token };
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

/** The fields of a Keycloak user representation the adapter reads. */
const KcUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().nullish(),
  enabled: z.boolean().nullish(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  attributes: z.record(z.array(z.string())).nullish(),
});
type KcUserPayload = z.infer<typeof KcUserSchema>;

/** A realm role, as the role-mappings endpoint needs it. */
const KcRoleSchema = z.object({ id: z.string(), name: z.string() });

/** An entry of a user's realm role mappings. */
const KcRoleNameSchema = z.object({ name: z.string() });

/** A group from the group search. Attributes of another shape read as none. */
const KcGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  attributes: z.record(z.array(z.string())).optional().catch({}),
});

/**
 * A list whose entries are parsed one by one; an entry of another shape is skipped.
 *
 * One malformed entry then does not hide the valid ones.
 *
 * @param entry - Schema of one entry.
 * @returns A schema for the list of valid entries.
 */
function validEntries<T>(entry: z.ZodType<T, z.ZodTypeDef, unknown>) {
  return z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const parsed = entry.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  );
}

/** The client_credentials token response. */
const KcTokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number() });

/**
 * Reads a Keycloak response body and checks its shape.
 *
 * The error message names the operation only; the body may hold personal data.
 *
 * @param res - A 2xx response.
 * @param schema - The expected shape.
 * @param op - Operation name for the error message.
 * @returns The parsed body, or `IDP_UNAVAILABLE` when it is not JSON or not that shape.
 */
async function readJson<T>(
  res: Response,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  op: string,
): Promise<IdpResult<T>> {
  const invalid: IdpResult<T> = {
    ok: false,
    error: { code: 'IDP_UNAVAILABLE', message: `${op}: unexpected response body` },
  };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return invalid;
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : invalid;
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
