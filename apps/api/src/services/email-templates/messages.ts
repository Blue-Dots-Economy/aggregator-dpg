/**
 * Externalised email copy: loading, layering, and lookup.
 *
 * Belongs to `@aggregator-dpg/api`. Ported from the Signals-DPG model
 * (`apps/api/src/notifications/email/`) so the two services layer copy the
 * same way rather than inventing parallel designs.
 *
 * Per-key precedence, lowest first:
 *
 *   1. bundled defaults (`messages.default.properties`, complete)
 *   2. `config/<network>/emails/messages.properties`
 *   3. `config/<network>/<brand>/emails/messages.properties`
 *   4. `EMAIL_MESSAGES_PATH` — per-instance escape hatch, wins over all
 *
 * Layers 2-4 are PARTIAL: a file lists only the keys it changes and everything
 * else falls through. Layer 1 must be complete, which
 * {@link assertMessagesComplete} enforces at boot — a hole there is a build
 * defect, not a deployment choice.
 *
 * Lookup is SYNCHRONOUS by design. The templates are sync functions called
 * from request handlers, and making them async would ripple through every call
 * site for no benefit. The bundled defaults are read once, lazily, with
 * `readFileSync` (a small file shipped next to this module); the override
 * layers are merged in at boot by {@link loadEmailMessageOverrides}, the same
 * shape as `setEmailBrand`.
 *
 * @module @aggregator-dpg/api
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigDir, resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { logger } from '../../logger.js';
import { parseProperties } from './parse-properties.js';
import { requiredMessageKeys } from './email-cases.js';

const DEFAULTS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'messages.default.properties',
);

let messages: Map<string, string> | null = null;

/**
 * Reads and parses the bundled defaults.
 *
 * @returns Parsed default entries.
 * @throws {Error} If the bundled file is missing — it ships with the module,
 *   so absence means a broken build, and failing here beats sending blanks.
 */
function loadDefaults(): Map<string, string> {
  const text = readFileSync(DEFAULTS_PATH, 'utf8');
  const parsed = parseProperties(text);
  if (parsed.malformedLines.length > 0) {
    // Bundled file — malformed lines are our own defect, so this is an error.
    logger.error({
      operation: 'emailMessages.loadDefaults',
      status: 'failure',
      malformed_lines: parsed.malformedLines,
    });
  }
  return parsed.entries;
}

/**
 * Returns the active copy index, loading the bundled defaults on first use.
 *
 * @returns Key → copy fragment.
 */
function index(): Map<string, string> {
  messages ??= loadDefaults();
  return messages;
}

/**
 * Looks up one copy fragment.
 *
 * @param key - Fully-qualified key, e.g. `applicant_approved.subject`.
 * @returns The fragment, or the key itself when absent — a visibly wrong
 *   string beats an empty paragraph, and {@link assertMessagesComplete}
 *   should already have caught it at boot.
 */
export function getMessage(key: string): string {
  return index().get(key) ?? key;
}

/**
 * Candidate override files, lowest precedence first.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Absolute paths, in the order they must be merged.
 */
export function emailMessageOverridePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const configDir = resolveConfigDir(env);
  const { network, brand } = resolveActiveNetwork(env);
  const paths = [path.join(configDir, network, 'emails', 'messages.properties')];
  if (brand) paths.push(path.join(configDir, network, brand, 'emails', 'messages.properties'));
  const instance = env.EMAIL_MESSAGES_PATH?.trim();
  if (instance) paths.push(instance);
  return paths;
}

/**
 * Merges the override layers over the bundled defaults.
 *
 * Called once from the server boot path. A missing override file is normal —
 * most deployments ship none — and is skipped silently. A file that exists but
 * cannot be read or parsed is logged and skipped: copy overrides must never
 * stop the API from starting.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Number of keys overridden, for the boot log.
 */
export async function loadEmailMessageOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const merged = new Map(loadDefaults());
  let overridden = 0;

  for (const file of emailMessageOverridePaths(env)) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue; // absent layer — the common case
    }
    const parsed = parseProperties(text);
    if (parsed.malformedLines.length > 0) {
      logger.warn({
        operation: 'emailMessages.loadOverrides',
        status: 'failure',
        file,
        malformed_lines: parsed.malformedLines,
      });
    }
    for (const [key, value] of parsed.entries) {
      // An override key that no case declares is almost certainly a typo, and
      // silently accepting it would leave the operator believing their edit
      // landed.
      if (!merged.has(key)) {
        logger.warn({
          operation: 'emailMessages.loadOverrides',
          status: 'skipped',
          file,
          key,
          reason: 'unknown_key',
        });
        continue;
      }
      merged.set(key, value);
      overridden += 1;
    }
    logger.info({ operation: 'emailMessages.loadOverrides', status: 'success', file });
  }

  messages = merged;
  return overridden;
}

/**
 * Verifies every key the case registry declares is present.
 *
 * @throws {Error} If any declared key is missing from the active index.
 */
export function assertMessagesComplete(): void {
  const active = index();
  const missing = requiredMessageKeys().filter((k) => !active.has(k));
  if (missing.length > 0) {
    throw new Error(`email copy is missing ${missing.length} key(s): ${missing.join(', ')}`);
  }
}

/**
 * Test seam — replaces the active index.
 *
 * @param entries - Copy entries, or `null` to fall back to bundled defaults.
 */
export function _setEmailMessages(entries: Map<string, string> | null): void {
  messages = entries;
}
