/**
 * Test helpers for RBAC in `@aggregator-dpg/api`: a runtime built the way
 * `initRbac` builds it, from the shipped `config/rbac.yaml` built-in roles
 * (plus any custom roles a test adds), with an in-process decision engine.
 */

import { join } from 'node:path';
import {
  indexRoles,
  loadRbacFile,
  type AuthorizerBase,
  type RoleDefinition,
  type RoleIndex,
} from '@aggregator-dpg/rbac';
import { AuthorizerFake } from '@aggregator-dpg/rbac/testing';
import type { RbacMode, RbacRuntime } from './runtime.js';

/**
 * The shipped built-in roles from `$CONFIG_ROOT/rbac.yaml`.
 *
 * @returns The built-in role definitions.
 */
export async function shippedRoles(): Promise<RoleDefinition[]> {
  return (await loadRbacFile([join(process.env.CONFIG_ROOT ?? '', 'rbac.yaml')])).roles;
}

/**
 * The shipped built-in roles plus `extra`, indexed.
 *
 * @param extra - Custom roles to add.
 * @returns The role index.
 */
export async function shippedRoleIndex(extra: RoleDefinition[] = []): Promise<RoleIndex> {
  return indexRoles([...(await shippedRoles()), ...extra]);
}

/**
 * A runtime for tests: the shipped roles (plus `extra`) and an engine.
 *
 * @param mode - `log` or `enforce`.
 * @param authorizer - The engine; defaults to an in-process fake.
 * @param extra - Custom roles to add.
 * @returns The runtime, ready for `_setRbacRuntime`.
 */
export async function testRbacRuntime(
  mode: Exclude<RbacMode, 'off'>,
  authorizer: AuthorizerBase = new AuthorizerFake(),
  extra: RoleDefinition[] = [],
): Promise<RbacRuntime> {
  return { mode, roles: await shippedRoleIndex(extra), authorizer };
}
