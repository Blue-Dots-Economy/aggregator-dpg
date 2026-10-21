/**
 * Route access declarations and their enforcement (`@aggregator-dpg/api`, RBAC).
 *
 * Every route declares who may call it in `config.rbac`; the app refuses to
 * boot without one ({@link assertRouteDeclared}). Each route file's auth
 * wrapper then calls {@link enforceRouteAccess} after the token is verified.
 */

import type { FastifyRequest, RouteOptions } from 'fastify';
import { CapabilitySchema, type Capability } from '@aggregator-dpg/rbac';
import { httpError } from '../../errors/http-error.js';
import type { AnyAuthContext, AuthContext } from '../auth/access-token.js';
import type { Actor } from '../auth/actor/interface.js';
import {
  checkAnyCapability,
  checkCapability,
  requirePermission,
  resolveCaller,
  type TokenIdentity,
} from './guard.js';
import { getRbacRuntime } from './runtime.js';
import { recordLoginIdentity } from '../identity-store/record.js';

/**
 * Who may call a route.
 *
 * - `capability`: an end user holding it (organisation set ∩ role, reach).
 *   With `strict`, a deny is refused in `log` mode too.
 * - `anyCapability`: an end user holding at least one of them, for a route an
 *   organisation's owner and the network admin share.
 * - `self`: an active account acting on its own record.
 * - `signed_in`: any known account.
 * - `service`: a Keycloak service-account token (no end user).
 * - `link_token`: a signed approval / grant / invite link; checked by the route.
 * - `public`: anyone; rate limits apply.
 */
export type RouteAccess =
  | { capability: Capability; strict?: true }
  | { anyCapability: readonly Capability[] }
  | { access: 'self' | 'signed_in' | 'service' | 'link_token' | 'public' };

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The route's access declaration (RBAC). */
    rbac?: RouteAccess;
  }
}

/** Token facts the checks need. */
export interface RouteCaller extends TokenIdentity {
  /** `preferred_username`; `service-account-<client>` for a service account. */
  preferredUsername?: string | undefined;
}

/**
 * Caller facts from an end-user token ({@link AuthContext}).
 *
 * @param ctx - The verified context.
 * @returns The caller for {@link enforceRouteAccess}.
 */
export function callerFromAuth(ctx: AuthContext): RouteCaller {
  return {
    ...(ctx.aggregatorId ? { aggregatorId: ctx.aggregatorId } : {}),
    subject: ctx.userId,
    preferredUsername: ctx.preferredUsername,
  };
}

/**
 * Caller facts from a user-or-service token ({@link AnyAuthContext}).
 *
 * @param ctx - The verified context.
 * @returns The caller for {@link enforceRouteAccess}.
 */
export function callerFromAny(ctx: AnyAuthContext): RouteCaller {
  return {
    ...(ctx.aggregatorId ? { aggregatorId: ctx.aggregatorId } : {}),
    subject: ctx.subject,
    preferredUsername: ctx.preferredUsername,
  };
}

/** Prefix Keycloak gives a service account's `preferred_username`. */
const SERVICE_ACCOUNT_PREFIX = 'service-account-';

/** Routes registered by plugins, not by this app's route files. */
const PLUGIN_ROUTE_PREFIXES = ['/api/reference', '/documentation'];

/**
 * Whether a `preferred_username` belongs to a Keycloak service account.
 *
 * `sub` cannot tell: it is a UUID for service accounts too.
 *
 * @param preferredUsername - The token's `preferred_username` claim.
 * @returns True for `service-account-<client>`.
 */
export function isServiceAccount(preferredUsername: string | undefined): boolean {
  return (preferredUsername ?? '').startsWith(SERVICE_ACCOUNT_PREFIX);
}

/** Declarations seen by {@link assertRouteDeclared}, keyed `METHOD url`. */
const declared = new Map<string, RouteAccess>();

/**
 * Returns every route declaration registered so far, sorted by `METHOD url`.
 *
 * @returns `[key, declaration]` pairs.
 */
export function listDeclaredRoutes(): Array<[string, RouteAccess]> {
  return [...declared.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Test helper — forget every recorded declaration. */
export function _resetDeclaredRoutes(): void {
  declared.clear();
}

/**
 * Capabilities a handler checks itself rather than declaring on its route.
 *
 * `contact.unmask` decides whether a response shows contact details plain or
 * masked (`showsContact` in `v1-user.ts`); it gates no route.
 */
const HANDLER_CHECKED: readonly Capability[] = ['contact.unmask'];

/**
 * The capabilities this build actually enforces somewhere.
 *
 * A permission can exist in the catalogue with nothing that checks it yet.
 * The console uses this to show which permissions have effect. It is derived
 * from the registered routes.
 *
 * @returns Every capability named by a route declaration or checked in a handler.
 */
export function enforcedCapabilities(): ReadonlySet<Capability> {
  const out = new Set<Capability>(HANDLER_CHECKED);
  for (const decl of declared.values()) {
    if ('capability' in decl) out.add(decl.capability);
  }
  return out;
}

/**
 * `onRoute` hook: refuses to register a route without a valid `config.rbac`.
 *
 * @param route - The route being registered.
 * @throws {Error} When the declaration is missing or names an unknown capability.
 */
export function assertRouteDeclared(route: RouteOptions): void {
  const url = route.url ?? '';
  const methods = [route.method].flat();
  if (methods.every((m) => m === 'HEAD')) return;
  if (PLUGIN_ROUTE_PREFIXES.some((p) => url.startsWith(p))) return;
  const decl = route.config?.rbac;
  if (!decl) {
    throw new Error(`RBAC: route ${methods.join(',')} ${url} has no config.rbac declaration`);
  }
  const named =
    'capability' in decl ? [decl.capability] : 'anyCapability' in decl ? decl.anyCapability : [];
  if ('anyCapability' in decl && named.length === 0) {
    throw new Error(`RBAC: route ${methods.join(',')} ${url} declares an empty anyCapability`);
  }
  if (named.some((c) => !CapabilitySchema.safeParse(c).success)) {
    throw new Error(`RBAC: route ${methods.join(',')} ${url} declares unknown capability`);
  }
  for (const m of methods) if (m !== 'HEAD') declared.set(`${m} ${url}`, decl);
}

/** Logs an access failure and throws in `enforce` mode. */
function refuse(
  req: FastifyRequest,
  access: string,
  reason: string,
  userId: string | undefined,
  mode: 'log' | 'enforce',
): void {
  req.log.warn({
    operation: 'rbac.access',
    status: mode === 'enforce' ? 'failure' : 'skipped',
    access,
    route: req.routeOptions.url,
    method: req.method,
    user_id: userId,
    mode,
    reasons: [reason],
  });
  if (mode === 'enforce') throw httpError('FORBIDDEN', { fields: { permission: access } });
}

/** Refuses (403 in `enforce` mode) an actor holding none of `capabilities`. */
async function enforceAny(
  req: FastifyRequest,
  actor: Actor,
  capabilities: readonly Capability[],
): Promise<void> {
  const out = await checkAnyCapability(req, actor, capabilities);
  if (!out.allowed) {
    throw httpError('FORBIDDEN', { fields: { permission: capabilities.join('|') } });
  }
}

/**
 * Applies the route's declaration to an authenticated caller of a route file's
 * own auth wrapper.
 *
 * Does nothing when RBAC is off. In `log` mode a failure is logged and the
 * request continues; in `enforce` mode it becomes `403 FORBIDDEN`. A `strict`
 * capability is refused in `log` mode too.
 *
 * @param req - The request; its route's `config.rbac` is read.
 * @param caller - Facts from the verified token.
 * @throws {HttpError} `FORBIDDEN` in `enforce` mode when the check fails.
 */
export async function enforceRouteAccess(req: FastifyRequest, caller: RouteCaller): Promise<void> {
  const rt = getRbacRuntime();
  if (!rt) return;
  const decl = req.routeOptions.config.rbac;
  if (!decl) return;

  // The actor resolver accepts a coordinator only through its recorded login.
  // Record it here so a first call to a `self` or `signed_in` route resolves.
  // Best effort; never overwrites a different link.
  if (caller.aggregatorId && !('access' in decl && decl.access === 'service')) {
    await recordLoginIdentity(caller.aggregatorId, caller.subject, 'rbac.recordIdentity');
  }

  if ('capability' in decl) {
    const out = await requirePermission(req, caller, decl.capability, { strict: decl.strict });
    if (!out.allowed) throw httpError('FORBIDDEN', { fields: { permission: decl.capability } });
    return;
  }
  if ('anyCapability' in decl) {
    const resolved = await resolveCaller(caller);
    if ('reason' in resolved) {
      refuse(req, decl.anyCapability.join('|'), resolved.reason, caller.aggregatorId, rt.mode);
      return;
    }
    await enforceAny(req, resolved.actor, decl.anyCapability);
    return;
  }
  if (decl.access === 'service') {
    if (!isServiceAccount(caller.preferredUsername)) {
      refuse(req, decl.access, 'not_service_account', caller.aggregatorId, rt.mode);
    }
    return;
  }
  if (decl.access === 'self' || decl.access === 'signed_in') {
    const resolved = await resolveCaller(caller);
    if ('reason' in resolved) {
      refuse(req, decl.access, resolved.reason, caller.aggregatorId, rt.mode);
    } else if (decl.access === 'self' && !resolved.actor.active) {
      refuse(req, decl.access, 'inactive', caller.aggregatorId, rt.mode);
    }
  }
}

/**
 * Applies the route's declaration to a caller already resolved by
 * `requireActor()` (the console routes), so the actor is read once.
 *
 * @param req - The request; its route's `config.rbac` is read.
 * @param actor - The resolved actor.
 * @throws {HttpError} `FORBIDDEN` in `enforce` mode when the check fails.
 */
export async function enforceActorRouteAccess(req: FastifyRequest, actor: Actor): Promise<void> {
  const rt = getRbacRuntime();
  if (!rt) return;
  const decl = req.routeOptions.config.rbac;
  if (!decl) return;
  if ('capability' in decl) {
    const out = await checkCapability(req, actor, decl.capability, { strict: decl.strict });
    if (!out.allowed) throw httpError('FORBIDDEN', { fields: { permission: decl.capability } });
    return;
  }
  if ('anyCapability' in decl) {
    await enforceAny(req, actor, decl.anyCapability);
    return;
  }
  if (decl.access === 'self' && !actor.active)
    refuse(req, decl.access, 'inactive', actor.userId, rt.mode);
}
