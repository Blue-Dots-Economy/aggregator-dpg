/**
 * Row mappers for the dashboard table (`web` app).
 *
 * Turn a Signals dashboard item into the row shape the table renders.
 */
import { mapDirectional } from '@/services/row-mapping';
import type { LifecycleStatus, ParticipantStatus, Provider, Seeker } from '@/types';
import { EMPTY_VALUE, avatarInitials, formatRelative } from './format';

/** Completion (percent) at which a row without `lifecycle_status` counts as `live`. */
const LIVE_COMPLETION_PCT = 100;

/** Prefix of the id given to a row without a `profile_item_id`. Such rows are not selectable. */
export const SYNTHETIC_ROW_ID_PREFIX = 'row-';

/**
 * Checks whether a row has a real item id and can be selected for bulk actions.
 *
 * @param row - A mapped row.
 */
export function isSelectableRow(row: { id: string }): boolean {
  return !row.id.startsWith(SYNTHETIC_ROW_ID_PREFIX);
}

/**
 * Returns a row's lifecycle from Signals' `lifecycle_status`.
 *
 * Falls back to the completion percentage when the field is missing; that
 * fallback can label an unconsented profile as `live`.
 *
 * @param raw - The item's `lifecycle_status`.
 * @param completion - The item's completion percentage.
 */
export function resolveLifecycleStatus(raw: unknown, completion: number): LifecycleStatus {
  if (raw === 'draft' || raw === 'live' || raw === 'paused') return raw;
  return completion >= LIVE_COMPLETION_PCT ? 'live' : 'draft';
}

/**
 * Maps a Signals `profile_status` onto the status pill value.
 *
 * @param raw - The item's `profile_status`.
 * @returns `at-risk` or `inactive` for those statuses, else `active`.
 */
export function mapSeekerStatus(raw: string | null): ParticipantStatus {
  if (raw === 'at_risk') return 'at-risk';
  if (raw === 'inactive') return 'inactive';
  return 'active';
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t: unknown): t is string => typeof t === 'string');
}

/**
 * Maps a Signals dashboard item onto the `Seeker` row shape.
 *
 * The dashboard response has no `city` or role fields, so those show as em dashes.
 *
 * @param participant - One item from `by_domain[<id>].items`.
 * @param locale - Locale for the joined date.
 * @param index - Position in the reply, used for the id of a row without `profile_item_id`.
 */
export function toSeekerRow(
  participant: Record<string, unknown>,
  locale: string,
  index: number,
): Seeker {
  // user_id is not unique per row, so the key is profile_item_id or the index.
  const profileItemId = stringField(participant.profile_item_id);
  const status = mapSeekerStatus(
    typeof participant.profile_status === 'string' ? participant.profile_status : null,
  );
  const completion =
    typeof participant.profile_completion_pct === 'number' ? participant.profile_completion_pct : 0;
  const lifecycle_status = resolveLifecycleStatus(participant.lifecycle_status, completion);
  const created = stringField(participant.profile_created_at);
  const updated = stringField(participant.profile_last_updated_at);
  const name =
    typeof participant.name === 'string' && participant.name.trim()
      ? participant.name
      : EMPTY_VALUE;
  const initiated = mapDirectional(participant.initiated);
  const received = mapDirectional(participant.received);
  return {
    // The prefix avoids clashing with a numeric profile_item_id.
    id: profileItemId || `${SYNTHETIC_ROW_ID_PREFIX}${index}`,
    name,
    city: EMPTY_VALUE,
    joined: created
      ? new Intl.DateTimeFormat(locale, {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }).format(new Date(created))
      : EMPTY_VALUE,
    avatar: avatarInitials(name),
    profile: { title: EMPTY_VALUE, exp: EMPTY_VALUE, verified: false, complete: completion },
    initiated,
    received,
    // Combined (initiated + received) view, kept for non-table consumers.
    applied: {
      total:
        initiated.create +
        initiated.accept +
        initiated.reject +
        initiated.cancel +
        received.create +
        received.accept +
        received.reject +
        received.cancel,
      accepted: initiated.accept + received.accept,
      rejected: initiated.reject + received.reject,
      pending: initiated.create + received.create,
      cancelled: initiated.cancel + received.cancel,
    },
    status,
    last: updated ? formatRelative(updated) : EMPTY_VALUE,
    actionableTags: stringArray(participant.actionable_tags),
    lifecycle_status,
  };
}

/**
 * Maps a Signals dashboard item onto the `Provider` row shape.
 *
 * Same as {@link toSeekerRow}; the dashboard has no role, so it is an em dash.
 *
 * @param participant - One item from `by_domain[<id>].items`.
 * @param locale - Locale for the joined date.
 * @param index - Position in the reply, used for the id of a row without `profile_item_id`.
 */
export function toProviderRow(
  participant: Record<string, unknown>,
  locale: string,
  index: number,
): Provider {
  return { ...toSeekerRow(participant, locale, index), role: EMPTY_VALUE };
}
