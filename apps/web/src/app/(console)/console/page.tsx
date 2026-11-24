/**
 * Console home page: the users of an owner of one organisation, those who
 * joined and those still invited, in one list. Everyone else is sent to the
 * organisations page. An owner without a coordinator account of their own gets
 * "Add myself to My Team" beside the invite button, unless the deployment turns
 * self-add off; the owner's own account is tagged "You" in the list.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { canInvite, CONSOLE_HOME_HREF, coordinatorsHref, selfAddOrgs } from '@/lib/capabilities';
import { AddMyselfButton } from '@/components/console/SelfAddDialog';
import { loadConsentContent } from '@/app/(public)/register/register-server';
import { ownerSelfAddMode } from '@/lib/features.server';
import { networkDomains, servedDomains } from '@/lib/console-domains.server';
import { Topbar } from '@/components/shell/Topbar';
import { buttonClass } from '@/components/ui/button-class';
import { ConsoleOrgCard } from '@/components/console/ConsoleOrgCard';
import { DomainChips } from '@/components/console/DomainChips';
import { MemberList, type MemberRow } from '@/components/console/MemberList';
import { readOpenInvites } from '@/lib/console-invites.server';
import { inviteRows, isListed, memberCounts } from '@/lib/console-members.server';
import { I } from '@/icons';
import {
  OrgReadResponseSchema,
  UserSearchResponseSchema,
} from '@aggregator-dpg/shared-primitives/user-org';

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
  const read = await consoleRead(`/v1/org/read/${homeOrgId}`, OrgReadResponseSchema);
  const homeOrg: OrgRow = {
    ...read.org,
    coordinator_count: read.coordinator_count,
    child_count: read.child_count,
    pending_count: read.pending_count,
  };
  return renderOrgHome(homeOrg, {
    showInvite: canInvite(me),
    canAddSelf:
      (await ownerSelfAddMode()) !== 'off' && selfAddOrgs(me).some((o) => o.id === homeOrg.id),
    ownAccountId: me.own_coordinator_account_id ?? null,
  });
}

/** What the viewer may do on the organisation home, and which row is theirs. */
interface OrgHomeViewer {
  showInvite: boolean;
  /** Offer "Add myself to My Team" for this organisation. */
  canAddSelf: boolean;
  /** The viewer's own coordinator account, tagged "You". */
  ownAccountId: string | null;
}

/** The owner's single organisation with its users and the invites not used yet. */
async function renderOrgHome(org: OrgRow, viewer: OrgHomeViewer) {
  const t = await getTranslations('console');
  const [page, domains, invites, consent] = await Promise.all([
    consoleRead('/v1/user/search', UserSearchResponseSchema, {
      filter: { org_id: org.id },
      limit: ORG_HOME_LIMIT,
    }),
    networkDomains(),
    readOpenInvites('user', org.id),
    viewer.canAddSelf ? loadConsentContent() : null,
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
      self: u.id === viewer.ownAccountId,
    }));
  const rows = [...users, ...(await inviteRows(invites, 1, { kind: 'user', orgId: org.id }))];
  const allInvites = invites !== null && !invites.next_cursor;
  const complete = page.next_cursor === null;
  // Without the network's domains there are no profile types to offer.
  const showAddSelf = viewer.canAddSelf && domains.length > 0;
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
            showAddSelf || viewer.showInvite ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                {showAddSelf ? (
                  <AddMyselfButton
                    orgs={[{ id: org.id, name: org.name }]}
                    domains={domains}
                    consent={consent?.aggregator ?? null}
                  />
                ) : null}
                {viewer.showInvite ? (
                  <Link
                    className={`${buttonClass('primary')} w-full justify-center sm:w-auto`}
                    href="/console/invite"
                  >
                    <I.mail size={16} />
                    {t('org_home.invite')}
                  </Link>
                ) : null}
              </div>
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
