import { describe, it, expect } from 'vitest';
import { planCompletionDispatch, type CompletionAction } from '../dispatch_completion.js';

const actions: CompletionAction[] = [
  { channel: 'sms', template_id: 'sms-1', delay_seconds: 0, max_retries: 3 },
  { channel: 'voice', template_id: 'voice-1', delay_seconds: 60, max_retries: 2 },
];

describe('planCompletionDispatch', () => {
  it('produces one directive per action when lifecycle=draft', () => {
    const plan = planCompletionDispatch({
      onboardResult: {
        user_id: 'u',
        profile_item_id: 'i',
        onboarded_at: '2026-06-06T00:00:00Z',
        lifecycle_status: 'draft',
        completion_pct: 40,
      },
      actions,
      participantId: 'p-1',
      aggregatorId: 'a-1',
    });
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({
      channel: 'sms',
      template_id: 'sms-1',
      delay_seconds: 0,
      max_retries: 3,
      participant_id: 'p-1',
      item_id: 'i',
      aggregator_id: 'a-1',
    });
    expect(plan[1]).toMatchObject({
      channel: 'voice',
      template_id: 'voice-1',
      delay_seconds: 60,
      max_retries: 2,
    });
  });

  it('returns no directives when lifecycle=live', () => {
    const plan = planCompletionDispatch({
      onboardResult: {
        user_id: 'u',
        profile_item_id: 'i',
        onboarded_at: '2026-06-06T00:00:00Z',
        lifecycle_status: 'live',
        completion_pct: 100,
      },
      actions,
      participantId: 'p-1',
      aggregatorId: 'a-1',
    });
    expect(plan).toEqual([]);
  });

  it('returns no directives when lifecycle absent (back-compat = live)', () => {
    const plan = planCompletionDispatch({
      onboardResult: { user_id: 'u', profile_item_id: 'i', onboarded_at: '2026-06-06T00:00:00Z' },
      actions,
      participantId: 'p-1',
      aggregatorId: 'a-1',
    });
    expect(plan).toEqual([]);
  });

  it('returns no directives when owned_elsewhere', () => {
    const plan = planCompletionDispatch({
      onboardResult: {
        user_id: 'u',
        profile_item_id: '',
        onboarded_at: '2026-06-06T00:00:00Z',
        owned_elsewhere: true,
      },
      actions,
      participantId: 'p-1',
      aggregatorId: 'a-1',
    });
    expect(plan).toEqual([]);
  });

  it('returns no directives when actions is empty', () => {
    const plan = planCompletionDispatch({
      onboardResult: {
        user_id: 'u',
        profile_item_id: 'i',
        onboarded_at: '2026-06-06T00:00:00Z',
        lifecycle_status: 'draft',
        completion_pct: 0,
      },
      actions: [],
      participantId: 'p-1',
      aggregatorId: 'a-1',
    });
    expect(plan).toEqual([]);
  });

  it('returns no directives when profile_item_id is empty (account_only response)', () => {
    const plan = planCompletionDispatch({
      onboardResult: {
        user_id: 'u',
        profile_item_id: '',
        onboarded_at: '2026-06-06T00:00:00Z',
        lifecycle_status: undefined,
      },
      actions,
      participantId: 'p-1',
      aggregatorId: 'a-1',
    });
    expect(plan).toEqual([]);
  });
});
