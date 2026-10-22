/**
 * Coordinator detail page: contact, approve or reject, and domains served.
 *
 * With access control on, also shows the coordinator's roles.
 */

import Link from 'next/link';
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
import { Card } from '@/components/ui/Card';
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
    // Roles; null when access control is off or not allowed.
    canManage
      ? consoleReadOptional<UserRolesResponse>(`/v1/user/roles/${encodeURIComponent(id)}`)
      : Promise.resolve(null),
    canManage ? consoleReadOptional<RolesResponse>('/v1/roles') : Promise.resolve(null),
  ]);
  return (
    <div className="flex flex-col gap-4">
      <Link className="text-primary-600 underline text-[13.5px]" href="/console/coordinators">
        {t('coordinator.back')}
      </Link>
      <h1 className="font-display text-[22px] font-bold text-ink-900">{user.name}</h1>
      <Card className="p-4 text-[13.5px] flex flex-col gap-1">
        <span>
          {t('account.name')}: {user.contact.name ?? '—'}
        </span>
        <span>
          {t('account.email')}: {user.contact.email}
        </span>
        <span>
          {t('account.phone')}: {user.contact.phone ?? '—'}
        </span>
      </Card>
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
  );
}
