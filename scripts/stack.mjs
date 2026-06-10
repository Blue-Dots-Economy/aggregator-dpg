#!/usr/bin/env node
// scripts/stack.mjs
//
// Cross-platform host-side orchestrator for the aggregator-dpg local stack.
// Single source of truth for setup/up/down/reset/logs/ps/psql/rebuild-web —
// replaces the POSIX-only Makefile recipe bodies. Uses only node: builtins.
// Belongs to the aggregator-dpg local-dev tooling (host-side, not shipped code).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository root (parent of scripts/). */
export const repoRoot = join(__dirname, '..');

/** Host entries the browser + containers must resolve to the local machine. */
export const HOST_ENTRIES = [
  ['127.0.0.1', 'keycloak'],
  ['127.0.0.1', 'minio'],
];

/** Subcommands the orchestrator accepts. */
export const COMMANDS = [
  'setup',
  'up',
  'dev',
  'down',
  'reset',
  'logs',
  'ps',
  'psql',
  'rebuild-web',
];

/** Thrown when argv contains no command or an unknown one. */
export class UsageError extends Error {
  /** @param {string | undefined} cmd - The offending command token. */
  constructor(cmd) {
    super(cmd ? `Unknown command: ${cmd}` : 'No command given');
    this.name = 'UsageError';
  }
}

export const USAGE = `Usage: node scripts/stack.mjs <${COMMANDS.join('|')}>`;

/**
 * Returns the OS-correct path to the hosts file.
 *
 * @param {NodeJS.Platform} platform - process.platform value.
 * @returns The hosts-file path for that platform.
 */
export function hostsFilePath(platform) {
  return platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
}

/**
 * Whether `.env` should be chmod-ed to 600.
 *
 * @param {NodeJS.Platform} platform - process.platform value.
 * @returns true on Unix, false on Windows (NTFS perms differ).
 */
export function shouldChmod(platform) {
  return platform !== 'win32';
}

/**
 * Decides which source file (if any) to copy into `.env`.
 *
 * @param {{ envExists: boolean, localExists: boolean, templateExists: boolean }} state
 * @returns 'skip' | 'env.local' | 'env.template' | 'none'.
 */
export function chooseEnvSource({ envExists, localExists, templateExists }) {
  if (envExists) return 'skip';
  if (localExists) return 'env.local';
  if (templateExists) return 'env.template';
  return 'none';
}

/**
 * Returns the HOST_ENTRIES not already present in the given hosts-file content.
 *
 * @param {string} content - Raw hosts-file text.
 * @param {Array<[string, string]>} entries - Entries to check (defaults to HOST_ENTRIES).
 * @returns The [ip, host] pairs that are missing.
 */
export function missingHostEntries(content, entries = HOST_ENTRIES) {
  return entries.filter(([ip, host]) => {
    const escapedIp = ip.replace(/\./g, '\\.');
    const re = new RegExp(`^\\s*${escapedIp}\\s+${host}(\\s|$)`, 'm');
    return !re.test(content);
  });
}

/**
 * Builds the manual-edit instructions printed on Windows when hosts entries are missing.
 *
 * @param {Array<[string, string]>} missing - Missing [ip, host] pairs.
 * @param {NodeJS.Platform} platform - process.platform value (defaults to 'win32').
 * @returns Multi-line instruction text.
 */
export function windowsHostsInstructions(missing, platform = 'win32') {
  const lines = missing.map(([ip, host]) => `${ip} ${host}`).join('\n');
  return [
    `Add these lines to ${hostsFilePath(platform)} (open Notepad as Administrator):`,
    '',
    lines,
    '',
    'Required so the browser and containers resolve the OIDC issuer to the same host.',
  ].join('\n');
}

/**
 * Extracts and validates the subcommand from process.argv.
 *
 * @param {string[]} argv - Full argv array (argv[2] is the command).
 * @returns The validated command string.
 * @throws {UsageError} If the command is missing or unrecognized.
 */
export function parseCommand(argv) {
  const cmd = argv[2];
  if (!cmd || !COMMANDS.includes(cmd)) {
    throw new UsageError(cmd);
  }
  return cmd;
}
