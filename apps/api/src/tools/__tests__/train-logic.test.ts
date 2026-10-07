import { describe, expect, it } from 'vitest';
import { PRE_TRAIN_WHEN, type JournalEntry } from '../../db/migrate-core.js';
import { trainLevel } from '../train-logic.js';

const LATEST = 1791500000000;
const journal: JournalEntry[] = [
  { when: 1700000000000, tag: '0000_init' },
  { when: PRE_TRAIN_WHEN, tag: '0022_campaign_pii_audit' },
  { when: 1790600000000, tag: '0023_drop_aggregator_profile' },
  { when: LATEST, tag: '0030_user_org_api' },
];
const row = (when: number) => ({ createdAt: when, hash: 'h' });

describe('trainLevel', () => {
  it('reads exactly 0022 as the start, with the whole train pending', () => {
    expect(trainLevel(journal, [row(1700000000000), row(PRE_TRAIN_WHEN)])).toEqual({
      state: 'start',
      appliedTag: '0022_campaign_pii_audit',
      pending: ['0023_drop_aggregator_profile', '0030_user_org_api'],
    });
  });

  it('reads the latest shipped migration as done', () => {
    expect(trainLevel(journal, [row(PRE_TRAIN_WHEN), row(LATEST)])).toEqual({
      state: 'done',
      appliedTag: '0030_user_org_api',
      pending: [],
    });
  });

  it('reads nothing applied as fresh', () => {
    expect(trainLevel(journal, null).state).toBe('fresh');
    expect(trainLevel(journal, []).pending).toHaveLength(4);
  });

  it('reads a shipped level part-way through the train as partial', () => {
    expect(trainLevel(journal, [row(PRE_TRAIN_WHEN), row(1790600000000)])).toEqual({
      state: 'partial',
      appliedTag: '0023_drop_aggregator_profile',
      pending: ['0030_user_org_api'],
    });
  });

  it('reads a level below 0022 or one this release does not ship as other', () => {
    expect(trainLevel(journal, [row(1700000000000)]).state).toBe('other');
    expect(trainLevel(journal, [row(PRE_TRAIN_WHEN + 1)])).toMatchObject({
      state: 'other',
      appliedTag: null,
    });
  });

  it('decides by the high-water mark, not the order of the rows', () => {
    expect(trainLevel(journal, [row(PRE_TRAIN_WHEN), row(1700000000000)]).state).toBe('start');
  });
});
