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
import { getTranslations } from 'next-intl/server';
import type {
  OrgHierarchyResponse,
  OrgReadResponse,
  OrgSearchResponse,
  RolesResponse,
  UserRolesResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead, consoleReadOptional } from '@/lib/console-api.server';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import {
  BackLink,
  ConsoleSection,
  ConsoleStatusPill,
  DetailList,
} from '@/components/console/ConsoleUi';
import { I } from '@/icons';
import { OrgEditForm } from '@/components/console/OrgEditForm';
import { OrgMoveDialog } from '@/components/console/OrgMoveDialog';
import { ChildOrgsTree } from '@/components/console/ChildOrgsTree';
import { RolesPanel } from '@/components/console/RolesPanel';
import { OwnerAccessRepair } from '@/components/console/OwnerAccessRepair';
import { can } from '@/lib/capabilities';
import { knownAsChoicesAt } from '@/lib/console-org-options';

/** How many organisations below this one the page lists. */
const CHILD_LIMIT = 100;

export default async function ConsoleOrgPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const t = await getTranslations('console');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  const { id } = await params;
  const canAssignOwner =
    actor.me.is_network_admin && can(actor.me.capabilities, 'network.administer');
  const data = await consoleRead<OrgReadResponse>(`/v1/org/read/${encodeURIComponent(id)}`);
  const { org, owner } = data;
  // Owner roles; null when access control is off.
  const [ownerRoles, catalogue] =
    canAssignOwner && org.org_type === 'aggregator'
      ? await Promise.all([
          consoleReadOptional<UserRolesResponse>(`/v1/user/roles/${encodeURIComponent(owner.id)}`),
          consoleReadOptional<RolesResponse>('/v1/roles'),
        ])
      : [null, null];
  // An owner also views, read-only, the orgs below its own.
  const own = actor.me.is_network_admin || actor.me.orgs.some((o) => o.id === org.id);
  const editable = org.org_type === 'aggregator' && !org.is_default && own;
  const canRename = actor.me.is_network_admin && can(actor.me.capabilities, 'network.administer');
  const canRepair = actor.me.is_network_admin && editable && org.status === 'active';
  const children =
    org.org_type === 'aggregator' && !org.is_default
      ? await consoleRead<OrgSearchResponse>('/v1/org/search', {
          filter: { descendants_of: org.id },
          limit: CHILD_LIMIT,
        })
      : null;
  // Limits and "known as" values; only the network admin can read them.
  const hierarchy = canRename ? await consoleRead<OrgHierarchyResponse>('/v1/org/hierarchy') : null;
  const knownAsOptions =
    hierarchy && editable ? knownAsChoicesAt(hierarchy.known_as.values, org.depth) : [];
  // The Default org and the root never move; only pending and active orgs can.
  const canMove =
    hierarchy !== null && editable && (org.status === 'pending' || org.status === 'active');
  const maxChildren = hierarchy?.limits.max_children ?? null;
  return (
    <>
      <div>
        <BackLink href="/console/orgs">{t('orgs.heading')}</BackLink>
        <Topbar title={org.name} subtitle={t('org.subtitle')} />
        {own ? null : (
          <p className="mt-2 rounded-lg bg-[var(--bd-tint-primary)] px-3 py-2 text-[13px] text-ink-600">
            {t('org.viewed_from_above')}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-6">
        <ConsoleSection
          title={t('org.overview')}
          action={
            org.org_type === 'aggregator' ? (
              <div className="flex flex-wrap items-center gap-2">
                {canMove && hierarchy ? (
                  <OrgMoveDialog
                    orgId={org.id}
                    orgName={org.name}
                    knownAs={org.known_as}
                    knownAsValues={hierarchy.known_as.values}
                  />
                ) : null}
                <Link
                  className={buttonClass('soft')}
                  href={`/console/coordinators?org_id=${org.id}`}
                >
                  <I.users size={15} />
                  {t('org.view_coordinators')}
                </Link>
              </div>
            ) : null
          }
        >
          <DetailList
            items={[
              { label: t('org.status'), value: <ConsoleStatusPill status={org.status} /> },
              {
                label: t('org.owner'),
                value: (
                  <div className="flex flex-col gap-2">
                    <div>
                      <div>{owner.contact.name ?? owner.contact.email}</div>
                      {owner.contact.name ? (
                        <div className="text-[12.5px] text-ink-500">{owner.contact.email}</div>
                      ) : null}
                    </div>
                    {canRepair ? <OwnerAccessRepair orgId={org.id} /> : null}
                  </div>
                ),
              },
              ...(org.org_type === 'aggregator'
                ? [{ label: t('org.parent'), value: org.parent_name ?? '—' }]
                : []),
              { label: t('org.depth'), value: String(org.depth) },
              {
                label: t('org.child_count'),
                value:
                  maxChildren === null
                    ? String(data.child_count)
                    : t('org.children_of_max', { count: data.child_count, max: maxChildren }),
              },
              {
                label: t('home.coordinators_label'),
                value: `${t('home.coordinators', { count: data.coordinator_count })} · ${t('home.pending', { count: data.pending_count })}`,
              },
            ]}
          />
        </ConsoleSection>
        <OrgEditForm
          org={org}
          editable={editable}
          canRename={canRename}
          knownAsOptions={knownAsOptions}
        />
        {children ? (
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
