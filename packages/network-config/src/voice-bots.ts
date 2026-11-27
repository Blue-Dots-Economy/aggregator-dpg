/**
 * Voice-bot checks that drop a bad entry instead of failing the config.
 *
 * A mistake in `voice_bots` or `default_voice_bots` removes only that entry
 * and is reported as a {@link NetworkConfigWarning}, so the rest of the
 * aggregator keeps working.
 *
 * @module @aggregator-dpg/network-config/voice-bots
 */

import type { z } from 'zod';
import {
  VoiceBotSchema,
  type AggregatorYaml,
  type NetworkConfigWarning,
  type VoiceBot,
} from './interface.js';

/** The raw config and the voice-bot entries removed from it. */
export interface SanitisedVoiceBots {
  value: unknown;
  warnings: NetworkConfigWarning[];
}

/** The bots that passed, as parsed and as written in the YAML. */
interface KeptBots {
  parsed: VoiceBot[];
  raw: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Joins a failed parse's issues into one line that never holds the input value. */
function issueReason(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`)
    .join('; ');
}

/**
 * Keeps the bots that parse and whose key is not already taken.
 *
 * @param rawBots - The `voice_bots` value as parsed from YAML.
 * @param warnings - Receives one warning per dropped bot.
 */
function keepValidBots(rawBots: unknown, warnings: NetworkConfigWarning[]): KeptBots {
  const kept: KeptBots = { parsed: [], raw: [] };
  if (!Array.isArray(rawBots)) {
    warnings.push({
      path: 'aggregator.voice_bots',
      code: 'VOICE_BOT_DROPPED',
      reason: 'voice_bots is not a list',
    });
    return kept;
  }
  rawBots.forEach((entry: unknown, i) => {
    const path = `aggregator.voice_bots.${i}`;
    const bot = VoiceBotSchema.safeParse(entry);
    if (!bot.success) {
      warnings.push({ path, code: 'VOICE_BOT_DROPPED', reason: issueReason(bot.error) });
    } else if (kept.parsed.some((b) => b.key === bot.data.key)) {
      warnings.push({
        path,
        code: 'VOICE_BOT_DROPPED',
        reason: `key '${bot.data.key}' is listed more than once`,
      });
    } else {
      kept.parsed.push(bot.data);
      kept.raw.push(entry);
    }
  });
  return kept;
}

/**
 * Keeps the defaults that name a kept bot serving that domain.
 *
 * @param rawDefaults - The `default_voice_bots` value as parsed from YAML.
 * @param bots - The bots that were kept.
 * @param warnings - Receives one warning per dropped default.
 * @returns The kept defaults, or `undefined` when the block is not a map.
 */
function keepValidDefaults(
  rawDefaults: unknown,
  bots: VoiceBot[],
  warnings: NetworkConfigWarning[],
): Record<string, string> | undefined {
  if (!isRecord(rawDefaults)) {
    warnings.push({
      path: 'aggregator.default_voice_bots',
      code: 'VOICE_BOT_DEFAULT_DROPPED',
      reason: 'default_voice_bots is not a map of domain to bot key',
    });
    return undefined;
  }
  const defaults: Record<string, string> = {};
  for (const [domain, key] of Object.entries(rawDefaults)) {
    const bot = typeof key === 'string' ? bots.find((b) => b.key === key) : undefined;
    if (bot?.domains.includes(domain)) {
      defaults[domain] = bot.key;
    } else {
      warnings.push({
        path: `aggregator.default_voice_bots.${domain}`,
        code: 'VOICE_BOT_DEFAULT_DROPPED',
        reason: `must name a listed voice bot that serves '${domain}'`,
      });
    }
  }
  return defaults;
}

/**
 * Removes invalid, duplicate and dangling voice-bot entries from parsed YAML.
 *
 * Runs before schema validation, so the remaining entries always pass it.
 * Warnings name the entry and the rule it broke, never the phone number.
 *
 * @param parsed - The YAML document as parsed, not yet validated.
 * @returns A copy with the bad entries removed, and one warning per removal.
 */
export function sanitiseVoiceBots(parsed: unknown): SanitisedVoiceBots {
  if (!isRecord(parsed) || !isRecord(parsed['aggregator'])) return { value: parsed, warnings: [] };
  const aggregator = { ...parsed['aggregator'] };
  const warnings: NetworkConfigWarning[] = [];

  let bots: VoiceBot[] = [];
  if (aggregator['voice_bots'] !== undefined) {
    const kept = keepValidBots(aggregator['voice_bots'], warnings);
    aggregator['voice_bots'] = kept.raw;
    bots = kept.parsed;
  }

  if (aggregator['default_voice_bots'] !== undefined) {
    const defaults = keepValidDefaults(aggregator['default_voice_bots'], bots, warnings);
    if (defaults === undefined) delete aggregator['default_voice_bots'];
    else aggregator['default_voice_bots'] = defaults;
  }

  return { value: { ...parsed, aggregator }, warnings };
}

/** Keeps the bots whose every domain exists in the network. */
function keepBotsInNetwork(
  bots: VoiceBot[],
  domainIds: ReadonlySet<string>,
  warnings: NetworkConfigWarning[],
): VoiceBot[] {
  return bots.filter((bot) => {
    const missing = bot.domains.find((id) => !domainIds.has(id));
    if (missing === undefined) return true;
    warnings.push({
      path: `aggregator.voice_bots.${bot.key}`, // by key: earlier drops shift the YAML index
      code: 'VOICE_BOT_DROPPED',
      reason: `bot '${bot.key}' serves domain '${missing}', which the network does not define`,
    });
    return false;
  });
}

/** Keeps the defaults whose domain exists and whose bot was kept. */
function keepDefaultsInNetwork(
  defaults: Record<string, string>,
  bots: VoiceBot[],
  domainIds: ReadonlySet<string>,
  warnings: NetworkConfigWarning[],
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [domain, key] of Object.entries(defaults)) {
    const known = domainIds.has(domain);
    if (known && bots.some((b) => b.key === key && b.domains.includes(domain))) {
      kept[domain] = key;
      continue;
    }
    warnings.push({
      path: `aggregator.default_voice_bots.${domain}`,
      code: 'VOICE_BOT_DEFAULT_DROPPED',
      reason: known
        ? `bot '${key}' was dropped`
        : `domain '${domain}' is not defined by the network`,
    });
  }
  return kept;
}

/** Warns for each domain that two or more bots serve with no default. */
function missingDefaultWarnings(
  bots: VoiceBot[],
  defaults: Record<string, string> | undefined,
): NetworkConfigWarning[] {
  const serving = new Map<string, number>();
  for (const domain of bots.flatMap((bot) => bot.domains)) {
    serving.set(domain, (serving.get(domain) ?? 0) + 1);
  }
  return [...serving]
    .filter(([domain, count]) => count > 1 && defaults?.[domain] === undefined)
    .map(([domain, count]): NetworkConfigWarning => ({
      path: `aggregator.default_voice_bots.${domain}`,
      code: 'VOICE_BOT_DEFAULT_MISSING',
      reason: `${count} voice bots serve '${domain}' and none is the default; links created without a bot choice get none`,
    }));
}

/**
 * Removes voice bots and defaults that name a domain the network lacks.
 *
 * Also reports each domain that two or more bots serve with no default: a
 * link created there without a bot choice gets no bot.
 * Updates `aggregator` in place, so later edits to it reach the resolved config.
 *
 * @param aggregator - The validated `aggregator` block.
 * @param domainIds - Domain ids of the fetched network.
 * @returns One warning per removed entry or missing default.
 */
export function dropVoiceBotsOutsideNetwork(
  aggregator: AggregatorYaml['aggregator'],
  domainIds: ReadonlySet<string>,
): NetworkConfigWarning[] {
  const warnings: NetworkConfigWarning[] = [];
  aggregator.voice_bots = keepBotsInNetwork(aggregator.voice_bots, domainIds, warnings);
  if (aggregator.default_voice_bots !== undefined) {
    aggregator.default_voice_bots = keepDefaultsInNetwork(
      aggregator.default_voice_bots,
      aggregator.voice_bots,
      domainIds,
      warnings,
    );
  }
  warnings.push(...missingDefaultWarnings(aggregator.voice_bots, aggregator.default_voice_bots));
  return warnings;
}
