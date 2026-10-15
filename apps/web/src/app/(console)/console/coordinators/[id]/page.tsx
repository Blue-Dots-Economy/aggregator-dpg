/**
 * One coordinator (user & org Phase 5): contact (plain within reach, P5-8),
 * approve / reject a pending one, and change the domains served. With RBAC
 * on, its roles: the base Coordinator role and additional roles to assign.
 */

import { getTranslations } from 'next-intl/server';
import type {
  RolesResponse,
  User,
  UserRolesResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead, consoleReadOptional } from '@/lib/console-api.server';
import { getConsoleActor } from '@/lib/console-actor';
import { can } from '@/lib/capabilities';
import { RolesPanel } from '@/components/console/RolesPanel';
import { Topbar } from '@/components/shell/Topbar';
import { BackLink, ConsoleSection, DetailList } from '@/components/console/ConsoleUi';
import { CoordinatorActions } from '@/components/console/CoordinatorActions';

interface ConfigPayload {
  domains?: Array<{ id: string; label: string }>;
}

/** The network's domains, from the public aggregator config (empty on failure). */
async function domains(): Promise<Array<{ id: string; label: string }>> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${base}/v1/aggregator-config`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const cfg = (await res.json()) as ConfigPayload;
    return (cfg.domains ?? []).map((d) => ({ id: d.id, label: d.label }));
  } catch {
    return [];
  }
}

export default async function ConsoleCoordinatorPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const t = await getTranslations('console');
  const { id } = await params;
  const actor = await getConsoleActor();
  const canManage = actor.ok && can(actor.me.capabilities, 'org.manage');
  const [user, domainList, userRoles, catalogue] = await Promise.all([
    consoleRead<User>(`/v1/user/read/${encodeURIComponent(id)}`),
    domains(),
    // RBAC roles: absent when access control is off or not allowed.
    canManage
      ? consoleReadOptional<UserRolesResponse>(`/v1/user/roles/${encodeURIComponent(id)}`)
      : Promise.resolve(null),
    canManage ? consoleReadOptional<RolesResponse>('/v1/roles') : Promise.resolve(null),
  ]);
  return (
    <>
      <div>
        <BackLink href="/console/coordinators">{t('coordinator.back')}</BackLink>
        <Topbar title={user.name} subtitle={user.contact.email} />
      </div>
      <div className="flex flex-col gap-6">
        <ConsoleSection title={t('coordinator.details')}>
          <DetailList
            items={[
              { label: t('account.name'), value: user.contact.name ?? '—' },
              { label: t('account.email'), value: user.contact.email },
              { label: t('account.phone'), value: user.contact.phone ?? '—' },
            ]}
          />
        </ConsoleSection>
        <CoordinatorActions user={user} domains={domainList} />
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
