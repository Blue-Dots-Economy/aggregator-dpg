/**
 * Roles (network admin, read-only, #871): every role the API enforces,
 * built-in and custom, with the permissions it grants. Other actors get "not
 * found", as for anything out of reach.
 */

import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { CatalogueRolesResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleReadOptional } from '@/lib/console-api.server';
import { can } from '@/lib/capabilities';
import { Card } from '@/components/ui/Card';
import { AccessTabs, RolesCatalogueTable } from '@/components/console/AccessCatalogue';

export default async function ConsoleAccessRolesPage() {
  const t = await getTranslations('console.access');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  if (!actor.me.is_network_admin || !can(actor.me.capabilities, 'network.administer')) notFound();
  const data = await consoleReadOptional<CatalogueRolesResponse>('/v1/rbac/roles');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-[22px] font-bold text-ink-900">{t('title')}</h1>
      <p className="text-[13.5px] text-ink-600">{t('intro')}</p>
      <AccessTabs current="roles" />
      {data ? (
        <Card className="p-2">
          <RolesCatalogueTable roles={data.roles} />
        </Card>
      ) : (
        <Card className="p-4 text-[13.5px]">{t('off')}</Card>
      )}
    </div>
  );
}
