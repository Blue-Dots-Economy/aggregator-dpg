/**
 * Public interface contract for the config-loader package.
 *
 * All concrete implementations must extend ConfigServiceBase. External packages
 * import exclusively from this subpath — never from src/fs/ or any other internal path.
 *
 * @module @aggregator-dpg/config-loader/interface
 */

import type { z } from 'zod';

/**
 * Supported deployment environments.
 * Drives which config/env/<env>.yaml override file is loaded.
 */
export type Env = 'development' | 'staging' | 'production' | 'test';

/**
 * Callback invoked after a successful config reload.
 * Receives no arguments — callers re-read via get() after being notified.
 */
export type ConfigChangeCallback = () => void;

/**
 * Returned by onChange() to cancel the subscription.
 * Call to prevent memory leaks when a listener is no longer needed.
 */
export type Unsubscribe = () => void;

/**
 * Extracts the TypeScript type for a config slice from a Zod schema.
 *
 * @typeParam S - A Zod object schema describing the config slice shape.
 *
 * @example
 * const mySchema = z.object({ baseUrl: z.string(), timeout: z.number() });
 * type MyConfig = ConfigSlice<typeof mySchema>;
 * // { baseUrl: string; timeout: number }
 */
export type ConfigSlice<S extends z.ZodTypeAny> = z.infer<S>;

/**
 * Abstract base class for the config service.
 *
 * Concrete implementations (FsConfigService, ConfigServiceFake) must extend
 * this class and implement every method with the exact same signature.
 *
 * @example
 * // Boot
 * const config = new FsConfigService();
 * await config.load('production');
 *
 * // Access
 * const url = config.require<string>('signalStack.baseUrl');
 */
export abstract class ConfigServiceBase {
  /**
   * Loads config for the given environment.
   *
   * Reads per-package defaults and env-specific overrides, interpolates env vars,
   * and validates the composite. Throws ConfigError on any failure — call once at boot.
   *
   * @param env - The deployment environment to load config for.
   * @throws {ConfigError} If any required key is missing, invalid, or unresolvable.
   */
  abstract load(env: Env): Promise<void>;

  /**
   * Returns the value at the given dotted path, or undefined if absent.
   *
   * @param path - Dotted key path, e.g. "signalStack.baseUrl".
   * @typeParam T - Expected type of the value.
   * @returns The value, or undefined if the path does not exist.
   */
  abstract get<T = unknown>(path: string): T | undefined;

  /**
   * Returns the value at the given dotted path, throwing if absent.
   *
   * @param path - Dotted key path, e.g. "signalStack.baseUrl".
   * @typeParam T - Expected type of the value.
   * @returns The value at the path.
   * @throws {ConfigError} If the path does not exist or the value is undefined.
   */
  abstract require<T = unknown>(path: string): T;

  /**
   * Returns the validated, typed config slice for the given package configKey.
   *
   * The slice is the top-level object nested under `key` in the merged tree,
   * already validated and Zod-coerced by `load()`. The caller provides the
   * TypeScript type — no re-validation occurs.
   *
   * @param key - The package's configKey (e.g. "signalStack", "db").
   * @typeParam T - The package's Config type (e.g. `SignalStackConfig`).
   * @returns The typed config slice.
   * @throws {ConfigError} With code CONFIG_KEY_MISSING if the key is absent.
   *
   * @example
   * const ss = config.slice<SignalStackConfig>('signalStack');
   * console.log(ss.baseUrl); // fully typed
   */
  abstract slice<T>(key: string): T;

  /**
   * Reloads config from disk without restarting the process.
   *
   * Validates the new config before replacing the current one.
   * Throws ConfigError if the reload fails — the previous config remains active.
   *
   * @throws {ConfigError} If the reloaded config fails validation.
   */
  abstract reload(): Promise<void>;

  /**
   * Registers a callback to be invoked after each successful reload.
   *
   * @param cb - Called with no arguments after config is refreshed.
   * @returns An unsubscribe function — call it to remove the listener.
   */
  abstract onChange(cb: ConfigChangeCallback): Unsubscribe;

  /**
   * Starts watching config files for changes and reloading on modification.
   *
   * Only active when `CONFIG_WATCH=1` is set and the environment is not
   * production. Returns a no-op unsubscribe in all other cases.
   *
   * Call after `load()`. The returned function stops the watcher — call it
   * on process shutdown to avoid open file-descriptor leaks.
   *
   * @returns Unsubscribe function that stops watching.
   */
  abstract watch(): Unsubscribe;
}
