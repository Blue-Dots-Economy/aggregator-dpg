/**
 * Coordinator detail page: contact, approve or reject, and domains served.
 *
 * With access control on, also shows the coordinator's roles. Read-only for a
 * viewer who cannot manage the coordinator's organisation.
 */

import { getTranslations } from 'next-intl/server';
import type {
  RolesResponse,
  User,
  UserRolesResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead, consoleReadOptional } from '@/lib/console-api.server';
import { getConsoleActor } from '@/lib/console-actor';
import { canManageOrg } from '@/lib/capabilities';
import { RolesPanel } from '@/components/console/RolesPanel';
import { Topbar } from '@/components/shell/Topbar';
import {
  BackLink,
  ConsoleSection,
  ConsoleStatusPill,
  DetailList,
} from '@/components/console/ConsoleUi';
import { networkDomains } from '@/lib/console-domains.server';
import { CoordinatorActions } from '@/components/console/CoordinatorActions';

export default async function ConsoleCoordinatorPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const t = await getTranslations('console');
  const { id } = await params;
  const actor = await getConsoleActor();
  const [user, domainList] = await Promise.all([
    consoleRead<User>(`/v1/user/read/${encodeURIComponent(id)}`),
    networkDomains(),
  ]);
  const canManage = actor.ok && !!user.org_id && canManageOrg(actor.me, user.org_id);
  const [userRoles, catalogue] = await Promise.all([
    // Roles; absent when access control is off or not allowed.
    canManage
      ? consoleReadOptional<UserRolesResponse>(`/v1/user/roles/${encodeURIComponent(id)}`)
      : Promise.resolve(null),
    canManage ? consoleReadOptional<RolesResponse>('/v1/roles') : Promise.resolve(null),
  ]);
  return (
    <>
      <div>
        <BackLink href="/console/coordinators">{t('coordinator.back')}</BackLink>
        <Topbar
          title={user.contact.name ?? user.contact.email}
          subtitle={`${user.name} · ${user.contact.email}`}
        />
      </div>
      <div className="flex flex-col gap-6">
        <ConsoleSection title={t('coordinator.details')}>
          <DetailList
            items={[
              { label: t('account.name'), value: user.contact.name ?? '—' },
              { label: t('account.email'), value: user.contact.email },
              { label: t('account.phone'), value: user.contact.phone ?? '—' },
              {
                label: t('coordinators.status'),
                value: <ConsoleStatusPill status={user.status} />,
              },
            ]}
          />
        </ConsoleSection>
        <CoordinatorActions user={user} domains={domainList} readOnly={!canManage} />
        {userRoles && catalogue && user.org_id ? (
          <RolesPanel
            userId={user.id}
            orgId={user.org_id}
            initial={userRoles}
            roles={catalogue.roles}
          />
        ) : null}
      </div>
    </>
  );
}
