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
import { Topbar } from '@/components/shell/Topbar';
import { ConsoleSection } from '@/components/console/ConsoleUi';
import { AccessTabs, RolesCatalogueTable } from '@/components/console/AccessCatalogue';

export default async function ConsoleAccessRolesPage() {
  const t = await getTranslations('console.access');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  if (!actor.me.is_network_admin || !can(actor.me.capabilities, 'network.administer')) notFound();
  const data = await consoleReadOptional<CatalogueRolesResponse>('/v1/rbac/roles');
  return (
    <>
      <Topbar title={t('title')} subtitle={t('intro')} />
      <div className="flex flex-col gap-6">
        <ConsoleSection flush action={<AccessTabs current="roles" />}>
          {data ? (
            <RolesCatalogueTable roles={data.roles} />
          ) : (
            <p className="p-5 text-[13.5px] text-ink-500">{t('off')}</p>
          )}
        </ConsoleSection>
      </div>
    </>
  );
}
