/**
 * Filesystem loader for the Signals participant realm roles.
 *
 * One Keycloak realm serves both DPGs, so a token that fails the coordinator
 * portal's `aggregator_id` gate may still be a valid Signals identity.
 * Recognising that positively is what lets the login screen say which account
 * the visitor is signed in as instead of guessing (#753).
 *
 * The list lives in the network's own `aggregator.config.yaml` —
 * `aggregator.signals.realm_roles` — rather than in a deployment env var, so it
 * travels with this repo's `config/` tree and needs no chart or values change
 * to reach a cluster. Same reasoning as the consent copy next door: config as
 * code, read server-side, no API round-trip.
 *
 * Resolution order (first file that EXISTS wins, no merging — a brand folder is
 * a complete copy of its network folder, per `config/README.md`):
 *   1. `<repoRoot>/config/<network>/<brand>/aggregator.config.yaml`
 *   2. `<repoRoot>/config/<network>/aggregator.config.yaml`
 *
 * @module @aggregator-dpg/config-loader/fs
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import { fileExists, findRepoRoot } from './repo-root.js';

/** Config file holding the per-network aggregator settings. */
const CONFIG_FILE = 'aggregator.config.yaml';

/**
 * Reads the role list out of a parsed `aggregator.config.yaml`.
 *
 * Accepts a YAML sequence (`[signals_participant, signals_admin]`) or a
 * comma-separated string, because the same value is also expressible through
 * the `SIGNALS_REALM_ROLES` env override and operators will copy one shape into
 * the other. An absent key is not an error — it means "unconfigured", which the
 * caller renders as generic copy.
 *
 * @param doc - Parsed YAML document, whatever shape it turned out to be.
 * @returns Trimmed, non-empty role names; empty when the key is absent.
 */
function extractRoles(doc: unknown): string[] {
  if (doc === null || typeof doc !== 'object') return [];
  const aggregator = (doc as Record<string, unknown>)['aggregator'];
  if (aggregator === null || typeof aggregator !== 'object') return [];
  const signals = (aggregator as Record<string, unknown>)['signals'];
  if (signals === null || typeof signals !== 'object') return [];
  const roles = (signals as Record<string, unknown>)['realm_roles'];

  if (Array.isArray(roles)) {
    return roles.map((r) => String(r).trim()).filter((r) => r.length > 0);
  }
  if (typeof roles === 'string') {
    return roles
      .split(',')
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  }
  return [];
}

/**
 * Loads the Signals participant realm roles for a network/brand.
 *
 * Returns an empty array when the key is simply absent — that is a valid
 * "unconfigured" state, which the caller reports as an unknown population and
 * renders as generic copy. It **throws** only when a config file exists but
 * cannot be read or parsed, so the caller can log a real fault rather than
 * treat a corrupt file as an empty one. The caller is expected to degrade
 * rather than surface the error: this value chooses a sentence, and a login
 * page that 500s over a YAML key would be a worse failure than a vague message.
 *
 * @param network - Network identifier (e.g. `"blue_dot"`, `"purple_dot"`).
 * @param brand - Optional brand sub-folder (e.g. `"upsdm"`).
 * @param configRoot - Optional absolute path to the directory owning `config/`.
 *   Discovered from `process.cwd()` when omitted.
 * @returns The configured role names, or an empty array when unconfigured.
 * @throws {ConfigError} If the monorepo root cannot be located, or a config
 *   file exists but cannot be read or parsed as YAML.
 */
export async function loadSignalsRealmRoles(
  network: string,
  brand?: string,
  configRoot?: string,
): Promise<string[]> {
  const repoRoot =
    configRoot ?? (await findRepoRoot(process.cwd(), 'SIGNALS_ROLES_CONFIG_ROOT_NOT_FOUND'));
  const configDir = join(repoRoot, 'config');

  const candidates = brand
    ? [join(configDir, network, brand, CONFIG_FILE), join(configDir, network, CONFIG_FILE)]
    : [join(configDir, network, CONFIG_FILE)];

  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue;
    let doc: unknown;
    try {
      doc = parseYaml(await readFile(candidate, 'utf8'));
    } catch (err) {
      throw new ConfigError(`Failed to read or parse ${CONFIG_FILE} at ${candidate}`, {
        code: 'SIGNALS_ROLES_CONFIG_READ_ERROR',
        details: { filePath: candidate, network, brand, cause: String(err) },
      });
    }
    const roles = extractRoles(doc);
    if (roles.length > 0) return roles;
  }

  return [];
}
