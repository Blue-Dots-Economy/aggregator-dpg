/**
 * Permissions (network admin, read-only, #871): every permission in the
 * catalogue, retired ones included, with the roles that grant it. Other
 * actors get "not found", as for anything out of reach.
 */

import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { CataloguePermissionsResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleReadOptional } from '@/lib/console-api.server';
import { can } from '@/lib/capabilities';
import { Topbar } from '@/components/shell/Topbar';
import { ConsoleSection } from '@/components/console/ConsoleUi';
import { AccessTabs, PermissionsCatalogueTable } from '@/components/console/AccessCatalogue';

export default async function ConsoleAccessPermissionsPage() {
  const t = await getTranslations('console.access');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  if (!actor.me.is_network_admin || !can(actor.me.capabilities, 'network.administer')) notFound();
  const data = await consoleReadOptional<CataloguePermissionsResponse>('/v1/rbac/permissions');
  return (
    <>
      <Topbar title={t('title')} subtitle={t('intro')} />
      <div className="flex flex-col gap-6">
        <ConsoleSection flush action={<AccessTabs current="permissions" />}>
          {data ? (
            <PermissionsCatalogueTable permissions={data.permissions} />
          ) : (
            <p className="p-5 text-[13.5px] text-ink-500">{t('off')}</p>
          )}
        </ConsoleSection>
      </div>
    </>
  );
}
