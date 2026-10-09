/**
 * One organisation (user & org Phase 5): owner, counts and the details form.
 * The Default org and the root are read-only; the name is the network
 * admin's only (P5-9, R8).
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type {
  OrgReadResponse,
  PermissionSetsResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead, consoleReadOptional } from '@/lib/console-api.server';
import { Card } from '@/components/ui/Card';
import { OrgEditForm } from '@/components/console/OrgEditForm';
import { PermissionSetForm } from '@/components/console/PermissionSetForm';
import { can } from '@/lib/capabilities';

export default async function ConsoleOrgPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations('console');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  const { id } = await params;
  const canSetAccess = actor.me.is_network_admin && can(actor.me.capabilities, 'orgs.onboard');
  const [data, sets] = await Promise.all([
    consoleRead<OrgReadResponse>(`/v1/org/read/${encodeURIComponent(id)}`),
    // PermissionSets: absent when access control is off.
    canSetAccess
      ? consoleReadOptional<PermissionSetsResponse>('/v1/org/permission-sets')
      : Promise.resolve(null),
  ]);
  const { org, owner } = data;
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
      {sets && org.org_type === 'aggregator' ? (
        <PermissionSetForm
          orgId={org.id}
          current={org.permission_set ?? null}
          sets={sets.sets.map((s) => s.name)}
          defaultName={sets.defaults[org.org_type] ?? ''}
        />
      ) : null}
    </div>
  );
}
