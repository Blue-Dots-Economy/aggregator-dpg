/**
 * Pure helpers for the console invite form: turning typed or pasted text into
 * recipients, applying the per-send cap, and reading the API's reply.
 *
 * @module apps/web/src/components/console/invite/invite-recipients
 */

import type { UserInviteResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { isEmailAddress, normaliseEmail } from '@aggregator-dpg/shared-primitives/phone';
import { RESPONSE_SHAPE_CODE, type ConsoleError } from '@/lib/console-client';

/** One address in the list, with the optional name for the greeting. */
export interface Recipient {
  email: string;
  name: string;
  valid: boolean;
}

/** An address the API did not email, with the reason key. */
export interface NotSent {
  email: string;
  reason: string;
}

/** The outcome shown after a send. */
export interface InviteResult {
  sent: number;
  notSent: NotSent[];
}

/** Keys that turn the typed text into a chip. */
export const COMMIT_KEYS = new Set(['Enter', ',', ';', ' ', 'Tab']);

/**
 * Splits pasted or typed text into new recipients, skipping blanks and
 * addresses already in the list.
 *
 * @param text - Raw text; commas, semicolons, spaces and new lines separate.
 * @param current - The recipients already added.
 * @returns The recipients to append, in order.
 */
export function parseRecipients(text: string, current: readonly Recipient[]): Recipient[] {
  const seen = new Set(current.map((r) => r.email));
  const added: Recipient[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const email = normaliseEmail(part);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    added.push({ email, name: '', valid: isEmailAddress(email) });
  }
  return added;
}

/**
 * Appends the addresses in `text` to `current`, up to `max` in total.
 *
 * @returns The new list and how many addresses did not fit.
 */
export function appendCapped(
  text: string,
  current: readonly Recipient[],
  max: number,
): { list: Recipient[]; skipped: number } {
  const added = parseRecipients(text, current);
  const room = Math.max(max - current.length, 0);
  return { list: [...current, ...added.slice(0, room)], skipped: Math.max(added.length - room, 0) };
}

/** The addresses the API did not email, with the reason key for each. */
export function notSentOf(res: UserInviteResponse): NotSent[] {
  return [
    ...res.existing.map((e) => ({ email: e.email, reason: e.status })),
    ...res.invalid.map((i) => ({ email: i.email, reason: i.reason })),
  ];
}

/**
 * The message key for a failed send, worded for the person sending the invites.
 * The per-send cap is an API setting, so a cap lower than the form knew has its
 * own message.
 */
export function failureKey(r: { status: number; error: ConsoleError }): string {
  if (r.error.code === RESPONSE_SHAPE_CODE) return 'invite.error.response_shape';
  if (r.status === 400 && r.error.fields?.field === 'recipients') return 'invite.too_many';
  if (r.status === 0) return 'invite.error.network';
  if (r.status === 400) return 'invite.error.invalid';
  if (r.status === 401) return 'invite.error.signed_out';
  if (r.status === 403) return 'invite.error.forbidden';
  if (r.status === 404 || r.status === 409) return 'invite.error.org_unavailable';
  if (r.status === 429) return 'invite.error.rate_limited';
  if (r.status >= 500) return 'invite.error.server';
  return 'invite.error.generic';
}
