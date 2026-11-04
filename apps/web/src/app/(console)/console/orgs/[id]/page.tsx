/**
 * Organisation detail page: owner, place in the tree, counts and the details form.
 *
 * The Default org and the root are read-only. Only the org's owner edits its
 * details, the name included; the network admin sees them read-only. The owner
 * of the parent org sets the org's "known as" value; the org's owner defines
 * the values for the organisations under it. Only the network admin can
 * re-grant an active org's owner access or move it under another parent. An
 * owner approves its child orgs by default, so no role is assigned here. An
 * owner also views, read-only, the organisations directly under its own, and
 * approves or rejects one that is pending; the
 * coordinators of such an organisation stay with its own owner. The
 * organisations directly under an aggregator org are listed read-only.
 */

import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Building2, CalendarDays, Clock, Layers, Network, Users } from 'lucide-react';
import type {
  OrgHierarchyResponse,
  OrgReadResponse,
  OrgSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { BackLink, ConsoleSection, ConsoleStatusPill } from '@/components/console/ConsoleUi';
import { CountTile } from '@/components/console/CountTile';
import { CopyButton } from '@/components/console/CopyButton';
import { initialsOf } from '@/lib/initials';
import { I } from '@/icons';
import { OrgEditForm } from '@/components/console/OrgEditForm';
import { KnownAsPicker } from '@/components/console/KnownAsPicker';
import { KnownAsValuesEditor } from '@/components/console/KnownAsValuesEditor';
import { OrgMoveDialog } from '@/components/console/OrgMoveDialog';
import { ChildOrgsTree } from '@/components/console/ChildOrgsTree';
import { OrgsTable } from '@/components/console/OrgsTable';
import { OwnerAccessRepair } from '@/components/console/OwnerAccessRepair';
import { can, canViewCoordinators } from '@/lib/capabilities';
import { loadOrgSchema } from '@/lib/org-schema.server';

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
  const data = await consoleRead<OrgReadResponse>(
    `/v1/org/read/${encodeURIComponent(id)}?fields=known_as_values,parent.known_as_values`,
  );
  const { org, owner } = data;
  // An owner also views, read-only, the orgs directly under its own.
  const own = actor.me.orgs.some((o) => o.id === org.id);
  // The org's users, for its owner; the network admin has no users page.
  const showUsers = own && canViewCoordinators(actor.me);
  const editable = org.org_type === 'aggregator' && !org.is_default && own;
  const canRename = actor.me.is_network_admin && can(actor.me.capabilities, 'network.administer');
  const orgSchema = await loadOrgSchema();
  const aggregatorOrg = org.org_type === 'aggregator' && !org.is_default;
  // The network admin repairs and moves the top-level organisations it views.
  const canRepair = canRename && aggregatorOrg && org.status === 'active';
  // A child org's own children are not visible to the parent's owner.
  const children =
    org.org_type === 'aggregator' && !org.is_default && own
      ? await consoleRead<OrgSearchResponse>('/v1/org/search', {
          filter: { parent_id: org.id },
          limit: CHILD_LIMIT,
        })
      : null;
  // Tree limits; only the network admin can read them.
  const hierarchy = canRename ? await consoleRead<OrgHierarchyResponse>('/v1/org/hierarchy') : null;
  const isOwner = owner.id === actor.me.user.id;
  // The parent and its list; null when the viewer cannot set this org's value.
  const parent = aggregatorOrg ? (org.parent ?? null) : null;
  // Null when the org cannot have child orgs.
  const knownAsValues = org.known_as_values ?? null;
  // The API takes list edits only on an active org the viewer owns.
  const canEditKnownAsValues = aggregatorOrg && isOwner && org.status === 'active';
  // The Default org and the root never move; only pending and active orgs can.
  const canMove =
    hierarchy !== null && aggregatorOrg && (org.status === 'pending' || org.status === 'active');
  const maxChildren = hierarchy?.limits.max_children ?? null;
  const childrenSub =
    maxChildren === null
      ? t('org.tile.children_sub')
      : t('org.children_of_max', { count: data.child_count, max: maxChildren });
  return (
    <>
      <div>
        <BackLink href="/console/orgs">{t('orgs.heading')}</BackLink>
        <Topbar
          right={
            org.org_type === 'aggregator' ? (
              <>
                {canMove && hierarchy ? <OrgMoveDialog orgId={org.id} orgName={org.name} /> : null}
                {showUsers ? (
                  <Link
                    className={buttonClass('soft')}
                    href={`/console/coordinators?org_id=${org.id}`}
                  >
                    <I.users size={15} />
                    {t('org.view_coordinators')}
                  </Link>
                ) : null}
              </>
            ) : null
          }
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
      </div>
      <div className="flex flex-col gap-6">
        {!own && aggregatorOrg && org.status === 'pending' ? (
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
            {canRepair ? (
              <div className="w-full sm:ml-auto sm:w-auto">
                <OwnerAccessRepair orgId={org.id} />
              </div>
            ) : null}
          </div>
        </section>
        <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
          {showUsers ? (
            <>
              <CountTile
                icon={<Users size={20} strokeWidth={2} />}
                tone="primary"
                label={t('org.tile.coordinators')}
                count={String(data.coordinator_count)}
                sub={t('org.tile.coordinators_sub')}
                muted={data.coordinator_count === 0}
                showLabel={t('org_home.tile_show')}
                href={`/console/coordinators?org_id=${org.id}`}
              />
              <CountTile
                icon={<Clock size={20} strokeWidth={2} />}
                tone="amber"
                label={t('org.tile.pending')}
                count={String(data.pending_count)}
                sub={data.pending_count ? t('org.tile.pending_sub') : t('org.tile.pending_none')}
                muted={data.pending_count === 0}
                showLabel={t('org_home.tile_show')}
                href={`/console/coordinators?org_id=${org.id}&status=pending`}
              />
            </>
          ) : null}
          {/* The Default org never has child orgs. */}
          {own && !org.is_default ? (
            <CountTile
              icon={<Network size={20} strokeWidth={2} />}
              tone="green"
              label={t('org.child_count')}
              count={String(data.child_count)}
              sub={childrenSub}
              muted={data.child_count === 0}
              {...(children ? { showLabel: t('org_home.tile_show'), href: '#children' } : {})}
            />
          ) : null}
          <CountTile
            icon={<Layers size={20} strokeWidth={2} />}
            tone="primary"
            label={t('org.tile.level')}
            count={String(org.depth)}
            sub={t('org.tile.level_sub')}
          />
        </div>
        {parent ? (
          <ConsoleSection title={t('org.known_as_pick_title')}>
            <KnownAsPicker org={org} parentValues={parent.known_as_values} />
          </ConsoleSection>
        ) : null}
        <OrgEditForm
          org={org}
          editable={editable}
          canEdit={isOwner}
          orgSchema={orgSchema}
          knownAsPicked={parent !== null}
        />
        {canEditKnownAsValues && knownAsValues !== null ? (
          <ConsoleSection title={t('org.known_as_values_title')}>
            <KnownAsValuesEditor orgId={org.id} values={knownAsValues} />
          </ConsoleSection>
        ) : null}
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
      </div>
    </>
  );
}
