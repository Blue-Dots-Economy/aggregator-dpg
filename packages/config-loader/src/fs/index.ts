/**
 * Filesystem implementation of ConfigServiceBase.
 *
 * Reads config/env/<env>.yaml override files and exposes typed get/require
 * accessors. Per-package schema discovery and defaults merging are added in
 * F-03.2 and F-03.3. Throws ConfigError on any load failure.
 *
 * Import via the ./fs subpath — never import from src/fs directly.
 *
 * @module @aggregator-dpg/config-loader/fs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import type { ConfigChangeCallback, Env, Unsubscribe } from '../interface.js';
import { ConfigServiceBase } from '../interface.js';
import { discoverPackages, type RegisteredPackage } from '../discovery.js';
import { deepMerge } from '../merge.js';
import { interpolateConfig } from '../interpolate.js';
import { validateConfig } from '../validate.js';
export { resolveEnv } from '../env.js';

/**
 * Resolves a dotted path into a nested object.
 * Returns undefined if any segment along the path is missing.
 */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === undefined || current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, obj);
}

/**
 * Loads YAML from disk. Returns an empty object if the file does not exist.
 *
 * @throws {ConfigError} If the file exists but cannot be parsed.
 */
function loadYaml(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = parseYaml(raw);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError(
        `Config file must be a YAML mapping, got ${typeof parsed}: ${filePath}`,
        { code: 'CONFIG_PARSE_ERROR' },
      );
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Failed to parse config file: ${filePath}`, {
      code: 'CONFIG_PARSE_ERROR',
      details: { cause: String(err) },
    });
  }
}

/**
 * Filesystem-backed ConfigService implementation.
 *
 * Reads config/env/<env>.yaml and exposes typed get/require accessors.
 * Call load() once at application boot before accessing any config values.
 */
export class FsConfigService extends ConfigServiceBase {
  private store: Record<string, unknown> = {};
  private currentEnv: Env | undefined;
  private readonly listeners = new Set<ConfigChangeCallback>();
  private readonly repoRoot: string;
  /** Populated after load() — keyed by configKey. */
  private registry = new Map<string, RegisteredPackage>();

  /**
   * @param repoRoot - Absolute path to the monorepo root. Defaults to process.cwd().
   */
  constructor(repoRoot: string = process.cwd()) {
    super();
    this.repoRoot = repoRoot;
  }

  /**
   * Loads config for the given environment.
   *
   * Discovers per-package configSchema + configKey, then merges
   * config/env/<env>.yaml overrides into the store.
   *
   * @param env - The deployment environment.
   * @throws {ConfigError} If schema discovery fails or any YAML file cannot be parsed.
   */
  async load(env: Env): Promise<void> {
    const packagesDir = join(this.repoRoot, 'packages');
    this.registry = await discoverPackages(packagesDir);

    // Seed store with per-package defaults (each nested under its configKey).
    const merged: Record<string, unknown> = {};
    for (const [key, pkg] of this.registry) {
      if (pkg.configDefaults !== undefined) {
        merged[key] = { ...pkg.configDefaults };
      }
    }

    // Env YAML deep-merges on top, overriding any defaults.
    const envFilePath = join(this.repoRoot, 'config', 'env', `${env}.yaml`);
    deepMerge(merged, loadYaml(envFilePath));

    // Interpolate ${VAR} / ${VAR:-default} placeholders before Zod validation.
    const interpolated = interpolateConfig(merged);

    // Validate against composite schema; store receives Zod-coerced output.
    this.store = validateConfig(interpolated, this.registry);
    this.currentEnv = env;
  }

  /**
   * Returns the discovered package registry.
   * Available after load() has been called.
   */
  getRegistry(): ReadonlyMap<string, RegisteredPackage> {
    return this.registry;
  }

  /**
   * Returns the validated, typed config slice for the given package configKey.
   *
   * @param key - The package's configKey (e.g. "signalStack").
   * @throws {ConfigError} With code CONFIG_KEY_MISSING if the key is absent.
   */
  slice<T>(key: string): T {
    const value = this.store[key];
    if (value === undefined) {
      throw new ConfigError(`Config slice not found: "${key}"`, {
        code: 'CONFIG_KEY_MISSING',
        details: { key },
      });
    }
    return value as T;
  }

  /**
   * Returns the value at the given dotted path, or undefined if absent.
   *
   * @param path - Dotted key path, e.g. "signalStack.baseUrl".
   */
  get<T = unknown>(path: string): T | undefined {
    return resolvePath(this.store, path) as T | undefined;
  }

  /**
   * Returns the value at the given dotted path, throwing if absent.
   *
   * @param path - Dotted key path.
   * @throws {ConfigError} If the path does not exist or the value is undefined.
   */
  require<T = unknown>(path: string): T {
    const value = resolvePath(this.store, path);
    if (value === undefined) {
      throw new ConfigError(`Required config key not found: "${path}"`, {
        code: 'CONFIG_KEY_MISSING',
        details: { path },
      });
    }
    return value as T;
  }

  /**
   * Reloads config from disk and notifies all onChange listeners on success.
   * Previous config remains active if reload fails.
   *
   * @throws {ConfigError} If the reload fails.
   */
  async reload(): Promise<void> {
    if (this.currentEnv === undefined) {
      throw new ConfigError('Cannot reload before initial load() call', {
        code: 'CONFIG_NOT_LOADED',
      });
    }
    const previous = this.store;
    try {
      await this.load(this.currentEnv);
    } catch (err) {
      this.store = previous;
      throw err;
    }
    for (const cb of this.listeners) {
      cb();
    }
  }

  /**
   * Registers a callback invoked after each successful reload.
   *
   * @param cb - Called after config is refreshed.
   * @returns Unsubscribe function to remove the listener.
   */
  onChange(cb: ConfigChangeCallback): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}
