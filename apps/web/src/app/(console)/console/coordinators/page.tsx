/**
 * Lists the coordinators the actor can reach, filtered by organisation, status
 * and served domain; each active filter shows as a chip that removes it.
 *
 * Newest first, paged by the API's cursor. Each row names the organisation the
 * coordinator belongs to, with its "known as" label. With access control on,
 * an Access column shows each coordinator's additional roles. The invite
 * button is hidden from a viewer who cannot invite.
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type {
  OrgSearchResponse,
  RolesResponse,
  UserSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';

type UserSearchOrg = OrgSearchResponse['orgs'][number];
import { consoleRead, consoleReadOptional } from '@/lib/console-api.server';
import { getConsoleActor } from '@/lib/console-actor';
import { canInvite } from '@/lib/capabilities';
import { RoleBadges } from '@/components/console/RoleBadges';
import { networkDomains, servedLabels } from '@/lib/console-domains.server';
import { CoordinatorFilters } from '@/components/console/CoordinatorFilters';
import { readReachableOrgs } from '@/lib/console-hierarchy.server';
import { orgOptionsInTreeOrder } from '@/lib/console-org-options';
import { ConsoleSection, ConsoleStatusPill, EmptyState } from '@/components/console/ConsoleUi';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { I } from '@/icons';

const STATUSES = ['pending', 'active', 'inactive', 'retired'] as const;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export default async function ConsoleCoordinatorsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ status?: string; org_id?: string; serves?: string; cursor?: string }>;
}>) {
  const t = await getTranslations('console');
  const params = await searchParams;
  const status = STATUSES.find((s) => s === params.status);
  const orgId = params.org_id && UUID_RE.test(params.org_id) ? params.org_id : undefined;
  const searchAfterDomains = networkDomains().then(async (domains) => {
    const serves = domains.find((d) => d.id === params.serves)?.id;
    const page = await consoleRead<UserSearchResponse>('/v1/user/search', {
      filter: {
        ...(status ? { status } : {}),
        ...(orgId ? { org_id: orgId } : {}),
        ...(serves ? { serves } : {}),
      },
      limit: 50,
      ...(params.cursor ? { cursor: params.cursor } : {}),
    });
    return { domains, serves, page };
  });
  const [{ domains, serves, page }, orgs, actor] = await Promise.all([
    searchAfterDomains,
    readReachableOrgs(),
    getConsoleActor(),
  ]);
  const orgOptions = orgOptionsInTreeOrder(orgs);
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  // Same gate the sidebar link used to apply, now checked here instead.
  const showInvite = actor.ok && canInvite(actor.me);
  const keep: Record<string, string> = {
    ...(orgId ? { org_id: orgId } : {}),
    ...(status ? { status } : {}),
    ...(serves ? { serves } : {}),
  };
  /** The list URL without one filter. */
  const without = (key: string) => {
    const rest = Object.fromEntries(Object.entries(keep).filter(([k]) => k !== key));
    const q = new URLSearchParams(rest).toString();
    return `/console/coordinators${q ? `?${q}` : ''}`;
  };
  const chips = [
    ...(orgId
      ? [
          {
            key: 'org_id',
            label: t('coordinators.org_filter'),
            value: orgById.get(orgId)?.name ?? orgId,
          },
        ]
      : []),
    ...(status
      ? [{ key: 'status', label: t('coordinators.status_filter'), value: t(`status.${status}`) }]
      : []),
    ...(serves
      ? [
          {
            key: 'serves',
            label: t('coordinators.serves_filter'),
            value: domains.find((d) => d.id === serves)?.label ?? serves,
          },
        ]
      : []),
  ];
  // Roles are null when access control is off: no Access column then.
  const showAccess = page.users.some((u) => Array.isArray(u.roles));
  const catalogue = showAccess ? await consoleReadOptional<RolesResponse>('/v1/roles') : null;
  const roleNames = Object.fromEntries((catalogue?.roles ?? []).map((r) => [r.key, r.name]));
  return (
    <>
      <Topbar title={t('coordinators.heading')} subtitle={t('coordinators.subtitle')} />
      <div className="flex flex-col gap-6">
        <ConsoleSection flush>
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-(--bd-border-soft) px-5 py-4">
            <CoordinatorFilters
              action="/console/coordinators"
              values={{ orgId: orgId ?? '', status: status ?? '', serves: serves ?? '' }}
              orgs={orgOptions}
              domains={domains}
            />
            {showInvite ? (
              <Link className={buttonClass('primary')} href="/console/invite">
                <I.mail size={14} />
                {t('nav.invite')}
              </Link>
            ) : null}
          </div>
          {chips.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-(--bd-border-soft) px-5 py-3">
              {chips.map((c) => (
                <Link
                  key={c.key}
                  href={without(c.key)}
                  aria-label={t('coordinators.clear_filter', { label: c.label })}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bd-tint-primary)] px-3 py-1 text-[12.5px] text-primary-600 hover:underline"
                >
                  <span className="text-ink-500">{c.label}:</span>
                  <span className="font-semibold">{c.value}</span>
                  <I.x size={12} />
                </Link>
              ))}
              <Link
                href="/console/coordinators"
                className="text-[12.5px] text-ink-500 hover:text-ink-700 hover:underline"
              >
                {t('coordinators.clear_all')}
              </Link>
            </div>
          ) : null}
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
                      <td>
                        <OrgCell
                          org={u.org_id ? orgById.get(u.org_id) : undefined}
                          registeredName={u.name}
                          registeredAs={t('coordinators.registered_as', { name: u.name })}
                        />
                      </td>
                      <td>
                        <ConsoleStatusPill status={u.status} />
                      </td>
                      <td className="bd-wrap">{servedLabels(u.serves, domains).join(', ')}</td>
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

/** The organisation a coordinator belongs to, linked, with its "known as" label. */
function OrgCell({
  org,
  registeredName,
  registeredAs,
}: Readonly<{
  org: UserSearchOrg | undefined;
  registeredName: string;
  registeredAs: string;
}>) {
  if (!org) return <span className="text-ink-700">{registeredName}</span>;
  const knownAs = org.known_as_name ?? org.known_as;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          className="text-ink-800 hover:text-primary-600 hover:underline"
          href={`/console/orgs/${org.id}`}
        >
          {org.name}
        </Link>
        {knownAs ? (
          <span className="rounded-md bg-[var(--bd-tint-primary)] px-1.5 py-0.5 text-[11.5px] font-semibold text-primary-600">
            {knownAs}
          </span>
        ) : null}
      </div>
      {registeredName !== org.name ? (
        <span className="text-[12px] text-ink-500">{registeredAs}</span>
      ) : null}
    </div>
  );
}
