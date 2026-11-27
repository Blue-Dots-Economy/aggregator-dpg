/**
 * Groups load warnings by what the operator has to do about them, so the API
 * and the worker log them under the same `finding` and message.
 *
 * @module @aggregator-dpg/network-config/warnings
 */

import type { NetworkConfigWarning } from './interface.js';

export type WarningFinding =
  'network_json_parts_dropped' | 'voice_bots_dropped' | 'voice_bot_default_missing';

/** Warnings that share a finding, with the log message for them. */
export interface WarningGroup {
  finding: WarningFinding;
  message: string;
  warnings: NetworkConfigWarning[];
}

const MESSAGES: Record<WarningFinding, string> = {
  network_json_parts_dropped:
    'network.json: malformed optional parts were dropped; defaults are used for them',
  voice_bots_dropped:
    'aggregator.config.yaml: invalid voice bot settings were ignored; fix them and redeploy',
  voice_bot_default_missing:
    'aggregator.config.yaml: a domain has two or more voice bots and no default; links created there without a bot choice get none',
};

function findingFor(code: NetworkConfigWarning['code']): WarningFinding {
  switch (code) {
    case 'VOICE_BOT_DROPPED':
    case 'VOICE_BOT_DEFAULT_DROPPED':
      return 'voice_bots_dropped';
    case 'VOICE_BOT_DEFAULT_MISSING':
      return 'voice_bot_default_missing';
    default:
      return 'network_json_parts_dropped';
  }
}

/**
 * Splits load warnings into one group per finding, skipping empty groups.
 *
 * @param warnings - The warnings from a resolved config.
 */
export function groupWarnings(warnings: readonly NetworkConfigWarning[] = []): WarningGroup[] {
  const groups = new Map<WarningFinding, NetworkConfigWarning[]>();
  for (const warning of warnings) {
    const finding = findingFor(warning.code);
    groups.set(finding, [...(groups.get(finding) ?? []), warning]);
  }
  return [...groups].map(([finding, list]) => ({
    finding,
    message: MESSAGES[finding],
    warnings: list,
  }));
}
