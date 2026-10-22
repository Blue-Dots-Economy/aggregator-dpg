/**
 * Organisation detail page: owner, counts and the details form.
 *
 * The Default org and the root are read-only. Only the network admin can
 * rename an org or assign roles to its owner.
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
import { Card } from '@/components/ui/Card';
import { OrgEditForm } from '@/components/console/OrgEditForm';
import { RolesPanel } from '@/components/console/RolesPanel';
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
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-[22px] font-bold text-ink-900">{org.name}</h1>
      <Card className="p-4 text-[13.5px] flex flex-col gap-1">
        <span>
          {t('org.status')}: {t(`status.${org.status}`)}
        </span>
        <span>
          {t('org.owner')}: {owner.contact.name ?? owner.contact.email} · {owner.contact.email}
        </span>
        <span>
          {t('home.coordinators', { count: data.coordinator_count })} ·{' '}
          {t('home.pending', { count: data.pending_count })}
        </span>
        {org.org_type === 'aggregator' ? (
          <Link
            className="text-primary-600 underline"
            href={`/console/coordinators?org_id=${org.id}`}
          >
            {t('org.view_coordinators')}
          </Link>
        ) : null}
      </Card>
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
  );
}
