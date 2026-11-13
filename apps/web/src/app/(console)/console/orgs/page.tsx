/**
 * Organisations page.
 *
 * An org owner sees the organisations directly under its own awaiting its
 * decision (approved or rejected in place), then each of its organisations
 * with the ones directly under it and, closed by default, its hierarchy
 * settings.
 *
 * The network admin sees the organisations directly under the network: those
 * awaiting approval, status tiles, a searchable list (each name opens the
 * organisation's page) and, closed by default, the hierarchy settings.
 * `?status=` opens the list with a filter.
 */

import { Fragment } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type {
  KnownAsValues,
  OrgHierarchyResponse,
  OrgReadResponse,
  OrgSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { canOnboardOrgsUnder } from '@/lib/capabilities';
import { consoleRead } from '@/lib/console-api.server';
import { readNetworkOrgs, readReachableOrgs } from '@/lib/console-hierarchy.server';
import { orgsBelow, topmostOwned } from '@/lib/console-org-options';
import { HierarchySettings } from '@/components/console/HierarchySettings';
import { ChildOrgsTree } from '@/components/console/ChildOrgsTree';
import { NetworkOrgsView } from '@/components/console/NetworkOrgsView';
import { ORG_FILTERS, type OrgFilter } from '@/lib/org-filters';
import { ConsoleSection } from '@/components/console/ConsoleUi';
import { OpenInvites } from '@/components/console/OpenInvites';
import { WaitingToVerify, type WaitingRow } from '@/components/console/WaitingToVerify';
import { readOpenInvites } from '@/lib/console-invites.server';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { I } from '@/icons';

type OrgRow = OrgSearchResponse['orgs'][number];

export default async function ConsoleOrgsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ status?: string }> }>) {
  const t = await getTranslations('console');
  const params = await searchParams;
  const initialFilter: OrgFilter = ORG_FILTERS.find((f) => f === params.status) ?? 'all';
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
      />
    );
  }
  const hierarchy = await consoleRead<OrgHierarchyResponse>(
    '/v1/org/hierarchy?fields=known_as_values',
  );
  const [network, invites] = await Promise.all([
    readNetworkOrgs(hierarchy.network.id),
    readOpenInvites('org', hierarchy.network.id),
  ]);
  return (
    <>
      <Topbar
        title={t('orgs.heading')}
        subtitle={t('orgs.subtitle')}
        right={canInviteOrgs ? inviteOrgsLink(t) : null}
      />
      <div className="flex flex-col gap-6">
        <NetworkOrgsView
          rootName={hierarchy.network.name}
          orgs={network.orgs}
          more={network.more}
          initialFilter={initialFilter}
        />
        <WaitingToVerify rows={waitingOrgs(network.orgs, hierarchy.network.id)} />
        {invites ? <OpenInvites page={invites} /> : null}
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
 * An owner's view: one section per topmost owned organisation with the
 * organisations under it, those registered and waiting to verify, its unused
 * invites and the "known as" values it defines for them.
 *
 * @param ownedIds - The organisations the viewer belongs to.
 * @param ownerIds - Those it owns, the only ones whose values it can edit.
 * @param canInviteOrgs - Whether it may invite organisations under any of them.
 */
async function OwnerOrgs({
  ownedIds,
  ownerIds,
  canInviteOrgs,
}: Readonly<{ ownedIds: string[]; ownerIds: string[]; canInviteOrgs: boolean }>) {
  const t = await getTranslations('console');
  const orgs = await readReachableOrgs();
  const roots = topmostOwned(ownedIds, orgs);
  if (roots.length === 0) redirect('/console');
  const valuesById = new Map(
    await Promise.all(
      roots.map(async (root) => [root.id, await knownAsValuesToEdit(root, ownerIds)] as const),
    ),
  );
  const invitesById = new Map(
    await Promise.all(
      roots.map(async (root) => [root.id, await readOpenInvites('org', root.id)] as const),
    ),
  );
  return (
    <>
      <Topbar
        title={t('orgs.heading')}
        subtitle={t('orgs.subtitle_owner')}
        right={canInviteOrgs ? inviteOrgsLink(t) : null}
      />
      <div className="flex flex-col gap-6">
        {roots.map((root) => (
          <Fragment key={root.id}>
            <ConsoleSection
              title={root.name}
              action={
                <Link className={buttonClass('soft')} href={`/console/orgs/${root.id}`}>
                  {t('orgs.manage')}
                  <I.arrowR size={15} />
                </Link>
              }
            >
              <ChildOrgsTree
                rootId={root.id}
                rootName={root.name}
                rootKnownAs={root.known_as_name ?? root.known_as}
                rootTag={t('orgs.yours')}
                orgs={orgsBelow(root.id, orgs).filter((o) => o.status !== 'pending')}
                linkRows
                more={false}
              />
            </ConsoleSection>
            <WaitingToVerify rows={waitingOrgs(orgs, root.id)} />
            {invitesById.get(root.id) ? <OpenInvites page={invitesById.get(root.id)!} /> : null}
            {valuesById.get(root.id) ? (
              <HierarchySettings
                orgId={root.id}
                orgName={root.name}
                values={valuesById.get(root.id) ?? []}
              />
            ) : null}
          </Fragment>
        ))}
      </div>
    </>
  );
}

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
  const read = await consoleRead<OrgReadResponse>(
    `/v1/org/read/${encodeURIComponent(root.id)}?fields=known_as_values`,
  );
  return read.org.known_as_values ?? null;
}

/**
 * The organisations directly under `parentId` that registered but have not verified yet.
 *
 * @param orgs - The organisations the viewer can see.
 * @param parentId - The organisation they registered under.
 */
function waitingOrgs(orgs: readonly OrgRow[], parentId: string): WaitingRow[] {
  return orgs
    .filter((o) => o.status === 'pending' && o.parent_id === parentId)
    .map((o) => ({
      id: o.id,
      name: o.name,
      href: `/console/orgs/${o.id}`,
      registeredAt: o.created_at,
    }));
}

/** The link to the Invite organisations page. */
function inviteOrgsLink(t: Awaited<ReturnType<typeof getTranslations<'console'>>>) {
  return (
    <Link className={buttonClass('primary')} href="/console/orgs/invite">
      <I.mail size={16} />
      {t('orgs.invite')}
    </Link>
  );
}
