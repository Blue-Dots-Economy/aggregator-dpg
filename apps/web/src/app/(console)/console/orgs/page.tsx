/**
 * Onboarded organisations page.
 *
 * An org owner sees, for each organisation it owns at the top of its tree, the
 * organisations under it and the invites nobody has used yet in one list, and,
 * closed by default, the "known as" values it defines for them.
 *
 * The network admin sees the same for the organisations directly under the
 * network. `?status=` opens the list with a filter.
 */

import { Fragment } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { KnownAsValues, OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { canOnboardOrgsUnder } from '@/lib/capabilities';
import { consoleRead } from '@/lib/console-api.server';
import { readNetworkOrgs, readReachableOrgsPage } from '@/lib/console-hierarchy.server';
import { orgsBelow, topmostOwned } from '@/lib/console-org-options';
import { HierarchySettings } from '@/components/console/HierarchySettings';
import { ConsoleOrgCard } from '@/components/console/ConsoleOrgCard';
import { MemberList, type MemberFilter, type MemberRow } from '@/components/console/MemberList';
import { readOpenInvites } from '@/lib/console-invites.server';
import { inviteRows, isListed, memberCounts } from '@/lib/console-members.server';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { I } from '@/icons';
import {
  OrgHierarchyResponseSchema,
  OrgReadResponseSchema,
} from '@aggregator-dpg/shared-primitives/user-org';

type OrgRow = OrgSearchResponse['orgs'][number];

const FILTERS: readonly MemberFilter[] = ['all', 'active', 'pending'];

type Translate = Awaited<ReturnType<typeof getTranslations<'console'>>>;

export default async function ConsoleOrgsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ status?: string }> }>) {
  const t = await getTranslations('console');
  const params = await searchParams;
  const initialFilter = FILTERS.find((f) => f === params.status) ?? 'all';
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  const me = actor.me;
  const canInviteOrgs = me.orgs.some((o) => o.role === 'owner' && canOnboardOrgsUnder(me, o));
  if (!me.is_network_admin) {
    return (
      <OwnerOrgs
        ownedIds={me.orgs.map((o) => o.id)}
        ownerIds={me.orgs.filter((o) => o.role === 'owner').map((o) => o.id)}
        canInviteOrgs={canInviteOrgs}
        initialFilter={initialFilter}
      />
    );
  }
  const hierarchy = await consoleRead(
    '/v1/org/hierarchy?fields=known_as_values',
    OrgHierarchyResponseSchema,
  );
  const [network, invites] = await Promise.all([
    readNetworkOrgs(hierarchy.network.id),
    readOpenInvites('org', hierarchy.network.id),
  ]);
  return (
    <>
      <Topbar title={t('orgs.heading')} subtitle={t('orgs.subtitle')} />
      <div className="flex flex-col gap-4">
        <ConsoleOrgCard
          name={hierarchy.network.name}
          note={t('orgs.network_note')}
          action={canInviteOrgs ? inviteOrgsLink(t) : null}
        />
        {await orgList(
          network.orgs,
          invites,
          { kind: 'org', orgId: hierarchy.network.id },
          !network.more,
          initialFilter,
        )}
        <HierarchySettings
          orgId={hierarchy.network.id}
          orgName={hierarchy.network.name}
          values={hierarchy.network.known_as_values ?? []}
        />
      </div>
    </>
  );
}

/**
 * An owner's view: for each topmost owned organisation, its card, the
 * organisations under it with the invites not used yet, and the "known as"
 * values it defines for them.
 *
 * @param ownedIds - The organisations the viewer belongs to.
 * @param ownerIds - Those it owns, the only ones whose values it can edit.
 * @param canInviteOrgs - Whether it may invite organisations under any of them.
 */
async function OwnerOrgs({
  ownedIds,
  ownerIds,
  canInviteOrgs,
  initialFilter,
}: Readonly<{
  ownedIds: string[];
  ownerIds: string[];
  canInviteOrgs: boolean;
  initialFilter: MemberFilter;
}>) {
  const t = await getTranslations('console');
  const { orgs, more } = await readReachableOrgsPage();
  const roots = topmostOwned(ownedIds, orgs);
  if (roots.length === 0) redirect('/console');
  const [values, lists] = await Promise.all([
    Promise.all(roots.map((root) => knownAsValuesToEdit(root, ownerIds))),
    Promise.all(
      roots.map(async (root) =>
        orgList(
          orgsBelow(root.id, orgs),
          await readOpenInvites('org', root.id),
          { kind: 'org', orgId: root.id },
          !more,
          initialFilter,
        ),
      ),
    ),
  ]);
  return (
    <>
      <Topbar title={t('orgs.heading')} subtitle={t('orgs.subtitle_owner')} />
      <div className="flex flex-col gap-4">
        {roots.map((root, i) => (
          <Fragment key={root.id}>
            <ConsoleOrgCard
              name={root.name}
              status={root.status}
              note={t('org_home.owner_note')}
              action={canInviteOrgs ? inviteOrgsLink(t) : null}
            />
            {lists[i]}
            {values[i] ? (
              <HierarchySettings orgId={root.id} orgName={root.name} values={values[i]} />
            ) : null}
          </Fragment>
        ))}
      </div>
    </>
  );
}

/**
 * The organisations and the invites not used yet, in one list.
 *
 * @param orgs - The organisations to list.
 * @param invites - The open invites, or `null` when they could not be read.
 * @param resend - Where an expired invite is sent again from.
 * @param complete - Whether `orgs` holds every organisation.
 * @param initialFilter - The filter the list opens on.
 */
async function orgList(
  orgs: readonly OrgRow[],
  invites: OrgInvites,
  resend: { kind: 'org'; orgId: string },
  complete: boolean,
  initialFilter: MemberFilter,
) {
  const t = await getTranslations('console');
  const format = await getFormatter();
  const joined: MemberRow[] = orgs
    .filter((o) => isListed(o.status))
    .sort((a, b) => Number(a.is_default) - Number(b.is_default))
    .map((o) => ({
      id: o.id,
      name: o.name,
      detail: o.is_default ? null : (o.known_as_name ?? o.known_as ?? null),
      status: o.status,
      href: `/console/orgs/${o.id}`,
      cells: [
        o.status === 'pending'
          ? '—'
          : format.dateTime(new Date(o.created_at), {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            }),
      ],
    }));
  const rows = [...joined, ...(await inviteRows(invites, 1, resend))];
  const allInvites = invites !== null && !invites.next_cursor;
  const defaultIds = new Set(orgs.filter((o) => o.is_default).map((o) => o.id));
  const counted = rows.filter((r) => !defaultIds.has(r.id));
  return (
    <MemberList
      kind="orgs"
      rows={rows}
      counts={memberCounts(counted, {}, complete && allInvites)}
      columns={[t('orgs.col_joined')]}
      footer={
        complete
          ? invites?.next_cursor
            ? t('open_invites.more', { count: invites.invites.length })
            : null
          : t('org.children_more')
      }
      initialFilter={initialFilter}
    />
  );
}

type OrgInvites = Awaited<ReturnType<typeof readOpenInvites>>;

/**
 * The "known as" values an owned organisation defines for its children, when
 * the viewer can edit them: it owns the org, the org is active, and the org can
 * have child organisations (the API sends null otherwise).
 *
 * @param root - The owned organisation.
 * @param ownerIds - The organisations the viewer owns.
 */
async function knownAsValuesToEdit(
  root: OrgRow,
  ownerIds: readonly string[],
): Promise<KnownAsValues | null> {
  if (!ownerIds.includes(root.id) || root.status !== 'active') return null;
  const read = await consoleRead(
    `/v1/org/read/${encodeURIComponent(root.id)}?fields=known_as_values`,
    OrgReadResponseSchema,
  );
  return read.org.known_as_values ?? null;
}

/** The link to the Invite organisations page. */
function inviteOrgsLink(t: Translate) {
  return (
    <Link
      className={`${buttonClass('primary')} w-full justify-center sm:w-auto`}
      href="/console/orgs/invite"
    >
      <I.mail size={16} />
      {t('orgs.invite')}
    </Link>
  );
}
