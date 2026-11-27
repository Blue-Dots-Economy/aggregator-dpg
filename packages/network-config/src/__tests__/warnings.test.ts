import { describe, expect, it } from 'vitest';
import type { NetworkConfigWarning } from '../interface.js';
import { groupWarnings } from '../warnings.js';

describe('groupWarnings', () => {
  const tiles: NetworkConfigWarning = {
    path: 'domains.0.dashboard_tiles',
    code: 'MALFORMED_BLOCK_DROPPED',
  };
  const badBot: NetworkConfigWarning = {
    path: 'aggregator.voice_bots.1',
    code: 'VOICE_BOT_DROPPED',
  };
  const badDefault: NetworkConfigWarning = {
    path: 'aggregator.default_voice_bots.seeker',
    code: 'VOICE_BOT_DEFAULT_DROPPED',
  };
  const noDefault: NetworkConfigWarning = {
    path: 'aggregator.default_voice_bots.provider',
    code: 'VOICE_BOT_DEFAULT_MISSING',
  };

  it('returns no groups when there are no warnings', () => {
    expect(groupWarnings()).toEqual([]);
    expect(groupWarnings([])).toEqual([]);
  });

  it('puts each warning under its finding, keeping their order', () => {
    const groups = groupWarnings([tiles, badBot, noDefault, badDefault]);
    expect(groups.map((g) => [g.finding, g.warnings])).toEqual([
      ['network_json_parts_dropped', [tiles]],
      ['voice_bots_dropped', [badBot, badDefault]],
      ['voice_bot_default_missing', [noDefault]],
    ]);
  });

  it('does not call a missing default invalid', () => {
    const [group] = groupWarnings([noDefault]);
    expect(group?.message).not.toContain('invalid');
    expect(group?.message).toContain('no default');
  });
});
