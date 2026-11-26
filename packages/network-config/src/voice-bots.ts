/**
 * Voice-bot checks that drop a bad entry instead of failing the config.
 *
 * A mistake in `voice_bots` or `default_voice_bots` removes only that entry
 * and is reported as a {@link NetworkConfigWarning}, so the rest of the
 * aggregator keeps working.
 *
 * @module @aggregator-dpg/network-config/voice-bots
 */

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const kept: VoiceBot[] = [];

  const rawBots = aggregator['voice_bots'];
  if (rawBots !== undefined) {
    if (!Array.isArray(rawBots)) {
      warnings.push({
        path: 'aggregator.voice_bots',
        code: 'VOICE_BOT_DROPPED',
        reason: 'voice_bots is not a list',
      });
      aggregator['voice_bots'] = [];
    } else {
      const keptRaw: unknown[] = [];
      rawBots.forEach((entry: unknown, i) => {
        const path = `aggregator.voice_bots.${i}`;
        const bot = VoiceBotSchema.safeParse(entry);
        if (!bot.success) {
          const reason = bot.error.issues
            .map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`)
            .join('; ');
          warnings.push({ path, code: 'VOICE_BOT_DROPPED', reason });
          return;
        }
        if (kept.some((b) => b.key === bot.data.key)) {
          warnings.push({
            path,
            code: 'VOICE_BOT_DROPPED',
            reason: `key '${bot.data.key}' is listed more than once`,
          });
          return;
        }
        kept.push(bot.data);
        keptRaw.push(entry);
      });
      aggregator['voice_bots'] = keptRaw;
    }
  }

  const rawDefaults = aggregator['default_voice_bots'];
  if (rawDefaults !== undefined) {
    if (!isRecord(rawDefaults)) {
      warnings.push({
        path: 'aggregator.default_voice_bots',
        code: 'VOICE_BOT_DEFAULT_DROPPED',
        reason: 'default_voice_bots is not a map of domain to bot key',
      });
      delete aggregator['default_voice_bots'];
    } else {
      const defaults: Record<string, string> = {};
      for (const [domain, key] of Object.entries(rawDefaults)) {
        const bot = typeof key === 'string' ? kept.find((b) => b.key === key) : undefined;
        if (bot?.domains.includes(domain) && typeof key === 'string') {
          defaults[domain] = key;
        } else {
          warnings.push({
            path: `aggregator.default_voice_bots.${domain}`,
            code: 'VOICE_BOT_DEFAULT_DROPPED',
            reason: `must name a listed voice bot that serves '${domain}'`,
          });
        }
      }
      aggregator['default_voice_bots'] = defaults;
    }
  }

  return { value: { ...parsed, aggregator }, warnings };
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

  aggregator.voice_bots = aggregator.voice_bots.filter((bot) => {
    const missing = bot.domains.find((id) => !domainIds.has(id));
    if (missing === undefined) return true;
    warnings.push({
      path: 'aggregator.voice_bots',
      code: 'VOICE_BOT_DROPPED',
      reason: `bot '${bot.key}' serves domain '${missing}', which the network does not define`,
    });
    return false;
  });

  if (aggregator.default_voice_bots !== undefined) {
    const defaults: Record<string, string> = {};
    for (const [domain, key] of Object.entries(aggregator.default_voice_bots)) {
      const bot = aggregator.voice_bots.find((b) => b.key === key);
      if (domainIds.has(domain) && bot?.domains.includes(domain)) {
        defaults[domain] = key;
      } else {
        warnings.push({
          path: `aggregator.default_voice_bots.${domain}`,
          code: 'VOICE_BOT_DEFAULT_DROPPED',
          reason: domainIds.has(domain)
            ? `bot '${key}' was dropped`
            : `domain '${domain}' is not defined by the network`,
        });
      }
    }
    aggregator.default_voice_bots = defaults;
  }

  const serving = new Map<string, number>();
  for (const bot of aggregator.voice_bots) {
    for (const domain of bot.domains) serving.set(domain, (serving.get(domain) ?? 0) + 1);
  }
  for (const [domain, count] of serving) {
    if (count > 1 && aggregator.default_voice_bots?.[domain] === undefined) {
      warnings.push({
        path: `aggregator.default_voice_bots.${domain}`,
        code: 'VOICE_BOT_DEFAULT_MISSING',
        reason: `${count} voice bots serve '${domain}' and none is the default; links created without a bot choice get none`,
      });
    }
  }

  return warnings;
}
