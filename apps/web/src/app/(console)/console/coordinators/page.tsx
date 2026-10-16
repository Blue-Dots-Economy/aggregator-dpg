/**
 * Coordinators within reach (user & org Phase 5): filtered by org and status,
 * newest first, paged by the API's cursor. With access control on, an Access
 * column shows the additional roles each holds (#873).
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { RolesResponse, UserSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead, consoleReadOptional } from '@/lib/console-api.server';
import { RoleBadges } from '@/components/console/RoleBadges';
import { networkDomains, servedLabels } from '@/lib/console-domains.server';
import { StatusFilter } from '@/components/console/StatusFilter';
import { ConsoleSection, ConsoleStatusPill, EmptyState } from '@/components/console/ConsoleUi';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { I } from '@/icons';

const STATUSES = ['pending', 'active', 'inactive', 'retired'] as const;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export default async function ConsoleCoordinatorsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ status?: string; org_id?: string; cursor?: string }>;
}>) {
  const t = await getTranslations('console');
  const params = await searchParams;
  const status = STATUSES.find((s) => s === params.status);
  const orgId = params.org_id && UUID_RE.test(params.org_id) ? params.org_id : undefined;
  const [page, domains] = await Promise.all([
    consoleRead<UserSearchResponse>('/v1/user/search', {
      filter: { ...(status ? { status } : {}), ...(orgId ? { org_id: orgId } : {}) },
      limit: 50,
      ...(params.cursor ? { cursor: params.cursor } : {}),
    }),
    networkDomains(),
  ]);
  const keep = { ...(status ? { status } : {}), ...(orgId ? { org_id: orgId } : {}) };
  // Roles are null when access control is off: no Access column then.
  const showAccess = page.users.some((u) => Array.isArray(u.roles));
  const catalogue = showAccess ? await consoleReadOptional<RolesResponse>('/v1/roles') : null;
  const roleNames = Object.fromEntries((catalogue?.roles ?? []).map((r) => [r.key, r.name]));
  return (
    <>
      <Topbar title={t('coordinators.heading')} subtitle={t('coordinators.subtitle')} />
      <div className="flex flex-col gap-6">
        <ConsoleSection
          flush
          action={
            <StatusFilter
              action="/console/coordinators"
              value={status ?? ''}
              hidden={orgId ? { org_id: orgId } : {}}
            />
          }
        >
          {page.users.length === 0 ? (
            <EmptyState>{t('coordinators.empty')}</EmptyState>
          ) : (
            <div className="overflow-x-auto scroll-x">
              <table className="bd-table">
                <thead>
                  <tr>
                    <th>{t('coordinators.coordinator')}</th>
                    <th>{t('coordinators.organisation')}</th>
                    <th>{t('coordinators.status')}</th>
                    <th>{t('coordinators.serves')}</th>
                    {showAccess ? <th>{t('coordinators.access')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {page.users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <Link
                          className="font-semibold text-primary-600 hover:underline"
                          href={`/console/coordinators/${u.id}`}
                        >
                          {u.contact.name ?? u.contact.email}
                        </Link>
                        {u.contact.name ? (
                          <div className="text-[12px] text-ink-500">{u.contact.email}</div>
                        ) : null}
                      </td>
                      <td className="text-ink-700">{u.name}</td>
                      <td>
                        <ConsoleStatusPill status={u.status} />
                      </td>
                      <td className="bd-wrap">
                        {servedLabels(u.serves, domains)?.join(', ') ??
                          t('coordinators.every_domain')}
                      </td>
                      {showAccess ? (
                        <td>
                          <RoleBadges roles={u.roles ?? []} names={roleNames} />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ConsoleSection>
        {page.next_cursor ? (
          <div>
            <a
              className={buttonClass('ghost')}
              href={`/console/coordinators?${new URLSearchParams({ ...keep, cursor: page.next_cursor }).toString()}`}
            >
              {t('coordinators.next')}
              <I.chevR size={14} />
            </a>
          </div>
        ) : null}
      </div>
    </>
  );
}
