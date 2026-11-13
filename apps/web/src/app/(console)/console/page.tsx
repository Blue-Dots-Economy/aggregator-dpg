/**
 * Console home page: the users of an owner of one organisation, those who
 * joined and those still invited, in one list. Everyone else is sent to the
 * organisations page.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type {
  OrgReadResponse,
  OrgSearchResponse,
  UserSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { canInvite, CONSOLE_HOME_HREF, coordinatorsHref } from '@/lib/capabilities';
import { networkDomains, servedDomains } from '@/lib/console-domains.server';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { ConsoleOrgCard } from '@/components/console/ConsoleOrgCard';
import { DomainChips } from '@/components/console/DomainChips';
import { MemberList, type MemberRow } from '@/components/console/MemberList';
import { readOpenInvites } from '@/lib/console-invites.server';
import { inviteRows, isListed, memberCounts } from '@/lib/console-members.server';
import { I } from '@/icons';

type OrgRow = OrgSearchResponse['orgs'][number];

/** Coordinators loaded for the single-organisation view, the API's page maximum. */
const ORG_HOME_LIMIT = 100;

export default async function ConsoleHomePage() {
  const actor = await getConsoleActor();
  if (!actor.ok) return null; // the layout already redirected
  const me = actor.me;
  // Everyone but an owner of one organisation works from the organisations page.
  if (coordinatorsHref(me) !== CONSOLE_HOME_HREF) redirect('/console/orgs');

  const homeOrgId = me.orgs.find((o) => o.org_type === 'aggregator' && !o.is_default)?.id;
  if (!homeOrgId) redirect('/console/orgs');
  const read = await consoleRead<OrgReadResponse>(`/v1/org/read/${homeOrgId}`);
  const homeOrg: OrgRow = {
    ...read.org,
    coordinator_count: read.coordinator_count,
    child_count: read.child_count,
    pending_count: read.pending_count,
  };
  return renderOrgHome(homeOrg, canInvite(me));
}

/** The owner's single organisation with its users and the invites not used yet. */
async function renderOrgHome(org: OrgRow, showInvite: boolean) {
  const t = await getTranslations('console');
  const [page, domains, invites] = await Promise.all([
    consoleRead<UserSearchResponse>('/v1/user/search', {
      filter: { org_id: org.id },
      limit: ORG_HOME_LIMIT,
    }),
    networkDomains(),
    readOpenInvites('user', org.id),
  ]);
  const users: MemberRow[] = page.users
    .filter((u) => isListed(u.status))
    .map((u) => ({
      id: u.id,
      name: u.contact.name ?? u.contact.email,
      detail: u.contact.name ? u.contact.email : null,
      status: u.status,
      href: `/console/coordinators/${u.id}`,
      cells: [<DomainChips key="domains" domains={servedDomains(u.serves, domains)} />],
    }));
  const rows = [...users, ...(await inviteRows(invites, 1, { kind: 'user', orgId: org.id }))];
  const allInvites = invites !== null && !invites.next_cursor;
  const complete = page.next_cursor === null;
  const counts = memberCounts(
    rows,
    allInvites ? { pending: org.pending_count + invites.invites.length } : {},
    complete && allInvites,
  );
  return (
    <>
      <Topbar title={t('org_home.heading')} subtitle={t('org_home.subtitle')} />
      <div className="flex flex-col gap-4">
        <ConsoleOrgCard
          name={org.name}
          status={org.status}
          note={t('org_home.owner_note')}
          action={
            showInvite ? (
              <Link
                className={`${buttonClass('primary')} w-full justify-center sm:w-auto`}
                href="/console/invite"
              >
                <I.mail size={16} />
                {t('org_home.invite')}
              </Link>
            ) : null
          }
        />
        <MemberList
          kind="users"
          rows={rows}
          counts={counts}
          columns={[t('org_home.col_domains')]}
          footer={
            complete
              ? invitesNote(invites, t)
              : t.rich('org_home.partial', {
                  count: page.users.length,
                  link: (chunks) => (
                    <Link
                      href={`/console/coordinators?org_id=${org.id}`}
                      className="font-semibold text-(--bd-primary-600) hover:underline"
                    >
                      {chunks}
                    </Link>
                  ),
                })
          }
        />
      </div>
    </>
  );
}

/** A note when only the newest invites were loaded, so the "+" on the counts is explained. */
function invitesNote(
  invites: Awaited<ReturnType<typeof readOpenInvites>>,
  t: Awaited<ReturnType<typeof getTranslations<'console'>>>,
) {
  return invites?.next_cursor ? t('open_invites.more', { count: invites.invites.length }) : null;
}
