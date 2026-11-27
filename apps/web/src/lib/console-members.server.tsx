/**
 * Server-side shaping of the console member lists (`@aggregator-dpg/web`):
 * invites nobody has used yet as list rows, and the tile counts.
 */

import 'server-only';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { InviteSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import type { MemberFilter, MemberRow } from '@/components/console/MemberList';
import { ResendInviteButton } from '@/components/console/ResendInviteButton';

/** The statuses the console lists show: joined, or still to verify. Rejected and retired are left out. */
export function isListed(status: string): boolean {
  return status === 'active' || status === 'pending';
}

/**
 * Turns unused invites into "invited" rows that name the address and when the
 * invite was sent or expired.
 *
 * @param page - The open invites, or `null` when they could not be read.
 * @param columns - How many extra cells the list shows; invites leave them empty.
 * @param resend - Where an expired invite is sent again from.
 */
export async function inviteRows(
  page: InviteSearchResponse | null,
  columns: number,
  resend: { kind: 'user' | 'org'; orgId: string },
): Promise<MemberRow[]> {
  if (!page) return [];
  const t = await getTranslations('console.open_invites');
  const format = await getFormatter();
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { day: 'numeric', month: 'short', year: 'numeric' });
  return page.invites.map((invite) => ({
    id: `invite:${invite.email}`,
    name: invite.email,
    detail:
      invite.status === 'expired'
        ? t('expired_on', { date: date(invite.expires_at) })
        : t('sent_on', { date: date(invite.created_at) }),
    status: 'pending',
    href: null,
    cells: Array.from({ length: columns }, () => '—'),
    ...(invite.status === 'expired'
      ? {
          action: (
            <ResendInviteButton kind={resend.kind} orgId={resend.orgId} email={invite.email} />
          ),
        }
      : {}),
  }));
}

/**
 * The tile counts: everyone, those who joined and those still invited, with
 * "+" on a count that only covers the loaded rows.
 *
 * @param rows - The rows the list shows.
 * @param exact - Counts known from the API, which win over counting `rows`.
 * @param complete - Whether `rows` holds every row.
 */
export function memberCounts(
  rows: readonly MemberRow[],
  exact: Partial<Record<MemberFilter, number>>,
  complete: boolean,
): Record<MemberFilter, string> {
  const counted = (f: MemberFilter) => {
    const n = f === 'all' ? rows.length : rows.filter((r) => r.status === f).length;
    return complete ? String(n) : `${n}+`;
  };
  const of = (f: MemberFilter) => (exact[f] === undefined ? counted(f) : String(exact[f]));
  return { all: of('all'), active: of('active'), pending: of('pending') };
}
