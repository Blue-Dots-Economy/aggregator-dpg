/**
 * Organisation detail page: owner, counts and the details form.
 *
 * The Default org and the root are read-only. Only the network admin can
 * rename an org, re-grant an active org's owner access, or assign roles to its
 * owner.
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type {
  OrgReadResponse,
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
import { RolesPanel } from '@/components/console/RolesPanel';
import { OwnerAccessRepair } from '@/components/console/OwnerAccessRepair';
import { can } from '@/lib/capabilities';

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
  const editable = org.org_type === 'aggregator' && !org.is_default;
  const canRepair = actor.me.is_network_admin && editable && org.status === 'active';
  return (
    <>
      <div>
        {actor.me.is_network_admin ? (
          <BackLink href="/console/orgs">{t('orgs.heading')}</BackLink>
        ) : (
          <BackLink href="/console">{t('nav.home')}</BackLink>
        )}
        <Topbar title={org.name} subtitle={t('org.subtitle')} />
      </div>
      <div className="flex flex-col gap-6">
        <ConsoleSection
          title={t('org.overview')}
          action={
            org.org_type === 'aggregator' ? (
              <Link className={buttonClass('soft')} href={`/console/coordinators?org_id=${org.id}`}>
                <I.users size={15} />
                {t('org.view_coordinators')}
              </Link>
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
          canRename={actor.me.is_network_admin && can(actor.me.capabilities, 'network.administer')}
        />
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
