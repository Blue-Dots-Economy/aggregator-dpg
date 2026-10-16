/**
 * Roles (RBAC R6, network admin): the built-in roles and the custom roles
 * composed from existing permissions. Other actors get "not found", as for
 * anything out of reach.
 */

import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { RolesResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleReadOptional } from '@/lib/console-api.server';
import { can } from '@/lib/capabilities';
import { Card } from '@/components/ui/Card';
import { RolesAdmin } from '@/components/console/RolesAdmin';

export default async function ConsoleRolesPage() {
  const t = await getTranslations('console');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  if (!actor.me.is_network_admin || !can(actor.me.capabilities, 'network.administer')) notFound();
  const data = await consoleReadOptional<RolesResponse>('/v1/roles');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-[22px] font-bold text-ink-900">{t('roles_admin.title')}</h1>
      {data ? (
        <RolesAdmin initial={data.roles} permissions={data.permissions} />
      ) : (
        <Card className="p-4 text-[13.5px]">{t('roles_admin.off')}</Card>
      )}
    </div>
  );
}
