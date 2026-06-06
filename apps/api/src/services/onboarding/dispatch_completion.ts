/**
 * Pure planner: maps a signals onboard result + the registration link's
 * `completion_actions` to dispatch directives.
 *
 * Lifecycle gating:
 *   - signals item is `draft` → emit one directive per action.
 *   - signals item is `live` or `paused` (or absent → back-compat live)
 *     → emit nothing.
 *   - signals reports `owned_elsewhere: true` (no item created here)
 *     → emit nothing.
 *
 * No I/O. No logging. Safe to call in a hot path. Use the dispatcher
 * service to enqueue the returned directives (Tasks 9 + 11).
 */
import { resolveLifecycle, type LifecycleStatus } from './lifecycle.js';

export interface CompletionAction {
  channel: 'sms' | 'voice' | 'chat';
  template_id: string;
  delay_seconds: number;
  max_retries: number;
}

export interface DispatchDirective extends CompletionAction {
  participant_id: string;
  item_id: string;
  aggregator_id: string;
}

export interface PlannerInput {
  onboardResult: {
    user_id: string;
    profile_item_id: string;
    onboarded_at: string;
    lifecycle_status?: LifecycleStatus | string | undefined;
    completion_pct?: number | undefined;
    owned_elsewhere?: boolean | undefined;
    already_registered?: boolean | undefined;
  };
  actions: ReadonlyArray<CompletionAction>;
  participantId: string;
  aggregatorId: string;
}

/**
 * Returns dispatch directives only when the resulting signals item is `draft`.
 *
 * @param input - Onboard result + the link's completion_actions + ids.
 * @returns Zero or more directives, one per applicable action.
 */
export function planCompletionDispatch(input: PlannerInput): DispatchDirective[] {
  if (input.onboardResult.owned_elsewhere) return [];
  if (input.onboardResult.already_registered) return [];
  if (!input.onboardResult.profile_item_id) return [];
  if (input.actions.length === 0) return [];

  const raw = input.onboardResult.lifecycle_status;
  const status = resolveLifecycle(raw === undefined ? {} : { lifecycle_status: raw });
  if (status !== 'draft') return [];

  return input.actions.map((a) => ({
    ...a,
    participant_id: input.participantId,
    item_id: input.onboardResult.profile_item_id,
    aggregator_id: input.aggregatorId,
  }));
}
