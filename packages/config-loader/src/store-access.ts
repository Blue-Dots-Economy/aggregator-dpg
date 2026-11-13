/**
 * Shared read accessors over a resolved config store.
 *
 * Internal module, not a subpath export. `FsConfigService` and
 * `InMemoryConfigService` delegate `slice` / `get` / `require` to these
 * functions. `ConfigServiceBase` stays fully abstract, so the shared logic
 * lives here instead of in the base class.
 *
 * @module @aggregator-dpg/config-loader
 */

import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { isObjectLike } from './record.js';

/**
 * Types a store value as the caller's `T`.
 *
 * The store is validated per package at load, but `T` is the caller's own
 * claim about one slice or path, which the store cannot check. This is the
 * only place that claim is made.
 *
 * @param value - A value read from the validated store.
 */
function asCallerType<T>(value: unknown): T {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return value as T;
}

/**
 * Resolves a dotted path into a nested object.
 *
 * @param obj - The store to walk.
 * @param path - Dotted key path, e.g. `signalStack.baseUrl`.
 * @returns The value at the path, or `undefined` if any segment is missing.
 */
export function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!isObjectLike(current)) return undefined;
    return current[key];
  }, obj);
}

/**
 * Returns the config slice registered under a package's configKey.
 *
 * @param store - The resolved config store.
 * @param key - The package's configKey (e.g. `signalStack`).
 * @returns The slice, cast to the caller's expected type.
 * @throws {ConfigError} With code `CONFIG_KEY_MISSING` if the key is absent.
 */
export function sliceFromStore<T>(store: Record<string, unknown>, key: string): T {
  const value = store[key];
  if (value === undefined) {
    throw new ConfigError(`Config slice not found: "${key}"`, {
      code: 'CONFIG_KEY_MISSING',
      details: { key },
    });
  }
  return asCallerType<T>(value);
}

/**
 * Returns the value at a dotted path, or `undefined` when absent.
 *
 * @param store - The resolved config store.
 * @param path - Dotted key path.
 * @returns The value, cast to the caller's expected type, or `undefined`.
 */
export function getFromStore<T = unknown>(
  store: Record<string, unknown>,
  path: string,
): T | undefined {
  return asCallerType<T | undefined>(resolvePath(store, path));
}

/**
 * Returns the value at a dotted path, throwing when absent.
 *
 * @param store - The resolved config store.
 * @param path - Dotted key path.
 * @returns The value, cast to the caller's expected type.
 * @throws {ConfigError} If the path does not exist or the value is undefined.
 */
export function requireFromStore<T = unknown>(store: Record<string, unknown>, path: string): T {
  const value = resolvePath(store, path);
  if (value === undefined) {
    throw new ConfigError(`Required config key not found: "${path}"`, {
      code: 'CONFIG_KEY_MISSING',
      details: { path },
    });
  }
  return asCallerType<T>(value);
}
