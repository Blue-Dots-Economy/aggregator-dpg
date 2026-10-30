/**
 * Console home page.
 *
 * An owner of one organisation sees that organisation and its coordinators,
 * and a summary of the organisations below it. An owner of several sees its
 * organisations with coordinator and pending counts and the same summary. The
 * network admin also sees the network and the organisations awaiting review.
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type {
  OrgReadResponse,
  OrgSearchResponse,
  UserSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { readNetworkOrgs, readReachableOrgs } from '@/lib/console-hierarchy.server';
import { OrgsTable } from '@/components/console/OrgsTable';
import { OrgStatusTiles, countOrgs, type OrgFilter } from '@/components/console/OrgStatusTiles';
import { can, canInvite, CONSOLE_HOME_HREF, coordinatorsHref } from '@/lib/capabilities';
import { networkDomains } from '@/lib/console-domains.server';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { ConsoleSection, ConsoleStatusPill, EmptyState } from '@/components/console/ConsoleUi';
import { OrgCoordinators, type OrgCoordinatorRow } from '@/components/console/OrgCoordinators';
import { I } from '@/icons';

type OrgRow = OrgSearchResponse['orgs'][number];

/** Coordinators loaded for the single-organisation view, the API's page maximum. */
const ORG_HOME_LIMIT = 100;

/** Where each status tile on the network admin's home leads. */
const ORG_LIST_HREFS: Record<OrgFilter, string> = {
  all: '/console/orgs?view=list',
  active: '/console/orgs?status=active',
  pending: '/console/orgs?status=pending',
  inactive: '/console/orgs?status=inactive',
};

export default async function ConsoleHomePage() {
  const t = await getTranslations('console');
  const actor = await getConsoleActor();
  if (!actor.ok) return null; // the layout already redirected
  const me = actor.me;

  // The actor's own aggregator orgs, read by id.
  const ownIds = me.orgs.filter((o) => o.org_type === 'aggregator').map((o) => o.id);
  const readOwned = Promise.all(
    ownIds.map(async (id): Promise<OrgRow> => {
      const r = await consoleRead<OrgReadResponse>(`/v1/org/read/${id}`);
      return {
        ...r.org,
        coordinator_count: r.coordinator_count,
        child_count: r.child_count,
        pending_count: r.pending_count,
      };
    }),
  );
  const root = me.orgs.find((o) => o.org_type === 'network_facilitator');
  if (me.is_network_admin && root) {
    const [own, network] = await Promise.all([readOwned, readNetworkOrgs(root.id)]);
    return renderNetworkHome(root.name, own, network, can(me.capabilities, 'network.administer'));
  }

  let owned: OrgRow[];
  let below: OrgRow[] = [];
  if (me.is_network_admin) {
    owned = await readOwned;
  } else {
    // For an owner, the reachable orgs are its own and every org below them.
    const [own, reach] = await Promise.all([readOwned, readReachableOrgs()]);
    owned = own;
    below = reach.filter((o) => !ownIds.includes(o.id));
  }

  // Same rule as the sidebar and the Back links (`coordinatorsHref`).
  const homeOrgId =
    coordinatorsHref(me) === CONSOLE_HOME_HREF
      ? me.orgs.find((o) => o.org_type === 'aggregator' && !o.is_default)?.id
      : undefined;
  const homeOrg = owned.find((o) => o.id === homeOrgId);
  if (homeOrg) {
    return renderOrgHome(homeOrg, below, canInvite(me));
  }

  return (
    <>
      <Topbar
        title={root ? `${t('home.network_heading')}: ${root.name}` : t('home.heading')}
        subtitle={me.is_network_admin ? t('home.subtitle_admin') : t('home.subtitle_owner')}
      />
      <div className="flex flex-col gap-6">
        <ConsoleSection title={root ? t('home.heading') : undefined}>
          {await renderOwnedCards(owned)}
        </ConsoleSection>

        {below.length > 0 ? await renderBelowSummary(below) : null}
      </div>
    </>
  );
}

/** The owner's single organisation with its coordinators. */
async function renderOrgHome(org: OrgRow, below: OrgRow[], showInvite: boolean) {
  const t = await getTranslations('console');
  const [page, domains] = await Promise.all([
    consoleRead<UserSearchResponse>('/v1/user/search', {
      filter: { org_id: org.id },
      limit: ORG_HOME_LIMIT,
    }),
    networkDomains(),
  ]);
  const rows: OrgCoordinatorRow[] = page.users.map((u) => ({
    id: u.id,
    name: u.contact.name ?? u.contact.email,
    email: u.contact.name ? u.contact.email : null,
    organisation: u.name,
    status: u.status,
    // An empty `serves` means every domain.
    domains:
      u.serves.length === 0
        ? domains
        : u.serves.map((id) => ({
            id,
            label: domains.find((d) => d.id === id)?.label ?? id,
          })),
  }));
  return (
    <>
      <Topbar title={t('org_home.heading')} subtitle={t('org_home.subtitle')} />
      <div className="flex flex-col gap-4">
        <div className="bd-card bd-shadow flex flex-wrap items-center gap-3.5 px-5 py-4">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-[11px] bg-(--bd-primary-50) text-(--bd-primary)">
            <I.briefcase size={20} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5 font-display text-[17px] font-extrabold text-ink-900">
              <span className="truncate">{org.name}</span>
              <ConsoleStatusPill status={org.status} />
            </div>
            <div className="text-[12.5px] text-ink-500">{t('org_home.owner_note')}</div>
          </div>
          {showInvite ? (
            <Link
              className={`${buttonClass('primary')} w-full justify-center sm:ml-auto sm:w-auto`}
              href="/console/invite"
            >
              <I.mail size={16} />
              {t('org_home.invite')}
            </Link>
          ) : null}
        </div>
        <OrgCoordinators
          rows={rows}
          total={org.coordinator_count}
          pending={org.pending_count}
          complete={page.next_cursor === null}
          allHref={`/console/coordinators?org_id=${org.id}`}
        />
        {below.length > 0 ? await renderBelowSummary(below) : null}
      </div>
    </>
  );
}

/** A summary of the organisations below the owner's own, with a link to them. */
async function renderBelowSummary(below: OrgRow[]) {
  const t = await getTranslations('console');
  return (
    <ConsoleSection
      title={t('home.below_heading')}
      action={
        <Link className={buttonClass('soft')} href="/console/orgs">
          {t('home.below_view')}
        </Link>
      }
    >
      <p className="text-[13.5px] text-ink-600">
        {t('home.below_summary', {
          orgs: below.length,
          coordinators: below.reduce((n, o) => n + o.coordinator_count, 0),
        })}
      </p>
    </ConsoleSection>
  );
}

/** The owner's organisations as cards with coordinator and pending counts. */
async function renderOwnedCards(owned: OrgRow[]) {
  const t = await getTranslations('console');
  return owned.length === 0 ? (
    <p className="text-[13.5px] text-ink-500">{t('home.no_orgs')}</p>
  ) : (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {owned.map((o) => (
        <li
          key={o.id}
          className="rounded-[12px] border border-(--bd-border) p-4 flex flex-col gap-3"
        >
          <div className="flex items-start justify-between gap-3">
            <Link
              className="font-display font-bold text-[16px] text-ink-900 hover:text-primary-600 hover:underline min-w-0 truncate"
              href={`/console/orgs/${o.id}`}
            >
              {o.name}
            </Link>
            <ConsoleStatusPill status={o.status} />
          </div>
          <div className="flex gap-6">
            <Link
              className="group rounded-[8px] -m-1 p-1 hover:bg-(--bd-border-soft)"
              href={`/console/coordinators?org_id=${o.id}`}
            >
              <div className="font-display font-bold text-[24px] leading-none text-ink-900">
                {o.coordinator_count}
              </div>
              <div className="text-[12px] text-ink-500 mt-1 group-hover:underline">
                {t('home.coordinators_label')}
              </div>
            </Link>
            <Link
              className="group rounded-[8px] -m-1 p-1 hover:bg-(--bd-border-soft)"
              href={`/console/coordinators?org_id=${o.id}&status=pending`}
            >
              <div className="font-display font-bold text-[24px] leading-none text-amber-600">
                {o.pending_count}
              </div>
              <div className="text-[12px] text-ink-500 mt-1 group-hover:underline">
                {t('home.pending_label')}
              </div>
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The network admin's home: the network, status tiles that open the
 * organisations list, the organisations waiting for review (decided in place),
 * and the admin's own organisations.
 */
async function renderNetworkHome(
  networkName: string,
  owned: OrgRow[],
  network: { orgs: OrgRow[]; more: boolean },
  canViewAccess: boolean,
) {
  const t = await getTranslations('console');
  const pending = network.orgs.filter((o) => o.status === 'pending');
  return (
    <>
      <Topbar
        title={`${t('home.network_heading')}: ${networkName}`}
        subtitle={t('home.subtitle_admin')}
      />
      <div className="flex flex-col gap-4">
        <div className="bd-card bd-shadow flex flex-wrap items-center gap-3.5 px-5 py-4">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-[11px] bg-(--bd-primary-50) text-(--bd-primary)">
            <I.globe size={20} />
          </span>
          <div className="min-w-0">
            <div className="truncate font-display text-[17px] font-extrabold text-ink-900">
              {networkName}
            </div>
            <div className="text-[12.5px] text-ink-500">{t('network_home.owner_note')}</div>
          </div>
          <div className="flex w-full gap-2 sm:ml-auto sm:w-auto">
            <Link
              className={`${buttonClass('soft')} flex-1 justify-center sm:flex-none`}
              href="/console/orgs"
            >
              <I.briefcase size={15} />
              {t('nav.organisations')}
            </Link>
            {canViewAccess ? (
              <Link
                className={`${buttonClass('soft')} flex-1 justify-center sm:flex-none`}
                href="/console/access/roles"
              >
                <I.shield size={15} />
                {t('nav.access')}
              </Link>
            ) : null}
          </div>
        </div>
        <OrgStatusTiles
          counts={countOrgs(network.orgs)}
          more={network.more}
          hrefs={ORG_LIST_HREFS}
        />
        <ConsoleSection title={t('orgs.review_heading', { count: pending.length })} flush>
          {pending.length === 0 ? (
            <EmptyState>{t('home.none_pending')}</EmptyState>
          ) : (
            <OrgsTable orgs={pending} />
          )}
        </ConsoleSection>
        <ConsoleSection title={t('home.heading')}>{await renderOwnedCards(owned)}</ConsoleSection>
      </div>
    </>
  );
}
