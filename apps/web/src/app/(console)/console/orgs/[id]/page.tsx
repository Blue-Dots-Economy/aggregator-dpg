/**
 * Organisation detail page: owner, place in the tree, counts and the details form.
 *
 * The Default org and the root are read-only. Only the network admin can
 * rename an org, re-grant an active org's owner access, assign roles to its
 * owner, change its "known as" value, or move it under another parent. An
 * owner also views, read-only, the organisations below its own. The
 * organisations below an aggregator org are listed read-only.
 */

import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Building2, CalendarDays, Clock, Layers, Network, Users } from 'lucide-react';
import type {
  OrgHierarchyResponse,
  OrgReadResponse,
  OrgSearchResponse,
  RolesResponse,
  UserRolesResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead, consoleReadOptional } from '@/lib/console-api.server';
import { isUuid } from '@/lib/console-proxy';
import { notFound } from 'next/navigation';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { BackLink, ConsoleSection, ConsoleStatusPill } from '@/components/console/ConsoleUi';
import { CountTile } from '@/components/console/CountTile';
import { CopyButton } from '@/components/console/CopyButton';
import { initialsOf } from '@/lib/initials';
import { I } from '@/icons';
import { OrgEditForm } from '@/components/console/OrgEditForm';
import { OrgMoveDialog } from '@/components/console/OrgMoveDialog';
import { OrgsTable } from '@/components/console/OrgsTable';
import { ChildOrgsTree } from '@/components/console/ChildOrgsTree';
import { RolesPanel } from '@/components/console/RolesPanel';
import { OwnerAccessRepair } from '@/components/console/OwnerAccessRepair';
import { knownAsChoicesAt } from '@/lib/console-org-options';
import { orgPageAccess } from '@/lib/console-org-access';

/** How many organisations below this one the page lists. */
const CHILD_LIMIT = 100;

export default async function ConsoleOrgPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const t = await getTranslations('console');
  const format = await getFormatter();
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  const { id } = await params;
  // Ids are UUIDs; anything else cannot exist, so it is a missing page, not an error.
  if (!isUuid(id)) notFound();
  const data = await consoleRead<OrgReadResponse>(`/v1/org/read/${encodeURIComponent(id)}`);
  const { org, owner } = data;
  const access = orgPageAccess(actor.me, org);
  const { own, editable, canRename, canRepair, canDecide } = access;
  // Owner roles; null when access control is off.
  const [ownerRoles, catalogue] = access.canAssignOwner
    ? await Promise.all([
        consoleReadOptional<UserRolesResponse>(`/v1/user/roles/${encodeURIComponent(owner.id)}`),
        consoleReadOptional<RolesResponse>('/v1/roles'),
      ])
    : [null, null];
  const children = access.listsChildren
    ? await consoleRead<OrgSearchResponse>('/v1/org/search', {
        filter: { descendants_of: org.id },
        limit: CHILD_LIMIT,
      })
    : null;
  // Limits and "known as" values; only the network admin can read them.
  const hierarchy = canRename ? await consoleRead<OrgHierarchyResponse>('/v1/org/hierarchy') : null;
  const knownAsOptions =
    hierarchy && editable ? knownAsChoicesAt(hierarchy.known_as.values, org.depth) : [];
  const canMove = hierarchy !== null && access.movable;
  const maxChildren = hierarchy?.limits.max_children ?? null;
  return (
    <>
      <div>
        <BackLink href="/console/orgs">{t('orgs.heading')}</BackLink>
        <Topbar
          leading={
            <span
              aria-hidden="true"
              className="grid h-14 w-14 flex-none place-items-center rounded-[14px] bg-(--bd-primary-50) text-(--bd-primary-600)"
            >
              <Building2 size={26} />
            </span>
          }
          title={
            <span className="flex flex-wrap items-center gap-3">
              {org.name}
              <ConsoleStatusPill status={org.status} />
              {(org.known_as_name ?? org.known_as) ? (
                <span className="rounded-full bg-(--bd-primary-50) px-2.5 py-0.5 text-[12px] font-semibold text-(--bd-primary-600)">
                  {org.known_as_name ?? org.known_as}
                </span>
              ) : null}
            </span>
          }
          subtitle={
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13.5px] text-ink-500">
              {org.org_type === 'aggregator' && org.parent_name ? (
                <span className="inline-flex items-center gap-1.5">
                  <Network size={15} aria-hidden="true" />
                  {t('org.under', { parent: org.parent_name })}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5">
                <Layers size={15} aria-hidden="true" />
                {t('org.level', { depth: org.depth })}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays size={15} aria-hidden="true" />
                {t('org.created', {
                  date: format.dateTime(new Date(org.created_at), {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  }),
                })}
              </span>
            </span>
          }
        />
        {own ? null : (
          <p className="mt-2 rounded-lg bg-[var(--bd-tint-primary)] px-3 py-2 text-[13px] text-ink-600">
            {t('org.viewed_from_above')}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-6">
        {canDecide ? (
          <ConsoleSection title={t('orgs.review_heading', { count: 1 })} flush>
            <OrgsTable
              orgs={[
                {
                  ...org,
                  coordinator_count: data.coordinator_count,
                  child_count: data.child_count,
                  pending_count: data.pending_count,
                },
              ]}
            />
          </ConsoleSection>
        ) : null}
        {org.org_type === 'aggregator' ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canMove && hierarchy ? (
              <OrgMoveDialog
                orgId={org.id}
                orgName={org.name}
                knownAs={org.known_as}
                parentId={org.parent_id}
                knownAsValues={hierarchy.known_as.values}
              />
            ) : null}
            <Link className={buttonClass('soft')} href={`/console/coordinators?org_id=${org.id}`}>
              <I.users size={15} />
              {t('org.view_coordinators')}
            </Link>
          </div>
        ) : null}
        <OwnerCard owner={owner} repairOrgId={canRepair ? org.id : null} />
        <OrgCountTiles data={data} maxChildren={maxChildren} linkChildren={children !== null} />
        <OrgEditForm
          org={org}
          editable={editable}
          canRename={canRename}
          knownAsOptions={knownAsOptions}
        />
        {children ? (
          <div id="children" className="scroll-mt-6">
            <ConsoleSection title={t('org.children')}>
              <ChildOrgsTree
                rootId={org.id}
                rootName={org.name}
                rootKnownAs={org.known_as_name ?? org.known_as}
                orgs={children.orgs}
                linkRows
                more={children.next_cursor !== null}
              />
            </ConsoleSection>
          </div>
        ) : null}
        {ownerRoles && catalogue ? (
          <RolesPanel
            userId={owner.id}
            orgId={org.id}
            initial={ownerRoles}
            roles={catalogue.roles}
            title={t('org.owner_roles')}
          />
        ) : null}
      </div>
    </>
  );
}

/**
 * The owner's card: name, email with a copy button, and the access repair action.
 *
 * @param props.owner - The organisation's owner.
 * @param props.repairOrgId - The org whose owner access can be re-granted here, or null.
 */
async function OwnerCard({
  owner,
  repairOrgId,
}: Readonly<{ owner: OrgReadResponse['owner']; repairOrgId: string | null }>) {
  const t = await getTranslations('console');
  return (
    <section className="bd-card bd-shadow overflow-hidden">
      <div className="flex flex-wrap items-center gap-3.5 px-[22px] py-5">
        <span
          aria-hidden="true"
          className="grid h-10 w-10 flex-none place-items-center rounded-full bg-(--bd-primary-50) text-[13px] font-bold text-(--bd-primary-600)"
        >
          {initialsOf(owner.contact.name ?? owner.contact.email)}
        </span>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-ink-500">{t('org.owner')}</div>
          <div className="truncate font-bold text-ink-900">
            {owner.contact.name ?? owner.contact.email}
          </div>
          <div className="flex items-center gap-1 text-[12.5px] text-ink-500">
            <span className="truncate">{owner.contact.email}</span>
            <CopyButton value={owner.contact.email} label={t('coordinator.copy_email')} />
          </div>
        </div>
        {repairOrgId ? (
          <div className="w-full sm:ml-auto sm:w-auto">
            <OwnerAccessRepair orgId={repairOrgId} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The organisation's count tiles: coordinators, pending review, organisations below and level.
 *
 * @param props.data - The organisation as read.
 * @param props.maxChildren - The configured limit of orgs directly below, or null.
 * @param props.linkChildren - The page lists the orgs below, so their tile links to the list.
 */
async function OrgCountTiles({
  data,
  maxChildren,
  linkChildren,
}: Readonly<{ data: OrgReadResponse; maxChildren: number | null; linkChildren: boolean }>) {
  const t = await getTranslations('console');
  return (
    <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
      <CountTile
        icon={<Users size={20} strokeWidth={2} />}
        tone="primary"
        label={t('org.tile.coordinators')}
        count={String(data.coordinator_count)}
        sub={t('org.tile.coordinators_sub')}
        muted={data.coordinator_count === 0}
        showLabel={t('org_home.tile_show')}
        href={`/console/coordinators?org_id=${data.org.id}`}
      />
      <CountTile
        icon={<Clock size={20} strokeWidth={2} />}
        tone="amber"
        label={t('org.tile.pending')}
        count={String(data.pending_count)}
        sub={data.pending_count ? t('org.tile.pending_sub') : t('org.tile.pending_none')}
        muted={data.pending_count === 0}
        showLabel={t('org_home.tile_show')}
        href={`/console/coordinators?org_id=${data.org.id}&status=pending`}
      />
      <CountTile
        icon={<Network size={20} strokeWidth={2} />}
        tone="green"
        label={t('org.child_count')}
        count={String(data.child_count)}
        sub={
          maxChildren === null
            ? t('org.tile.children_sub')
            : t('org.children_of_max', { count: data.child_count, max: maxChildren })
        }
        muted={data.child_count === 0}
        {...(linkChildren ? { showLabel: t('org_home.tile_show'), href: '#children' } : {})}
      />
      <CountTile
        icon={<Layers size={20} strokeWidth={2} />}
        tone="primary"
        label={t('org.tile.level')}
        count={String(data.org.depth)}
        sub={t('org.tile.level_sub')}
      />
    </div>
  );
}
