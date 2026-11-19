'use client';

/**
 * The organisation console's sidebar, in the same shell as the coordinator
 * portal's ({@link AppSidebar}): Dashboard, My Team inside the My Blue Dots group,
 * Onboarded Organisations and Account Details. My Team needs `org.manage` in an owned
 * organisation (the API also checks it), so the network admin has none; Account Details
 * is the caller's own organisation. An owner with their own coordinator account also
 * gets "Onboard participants" under My onboarding, which switches the session to acting
 * as that account and opens its onboarding. "My account" opens from the account card
 * at the foot of the sidebar (`SidebarAccount.details`).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppSidebar, type NavItem, type SidebarAccount } from '../shell/Sidebar';
import { ACTING_NOT_READY, errorKey, startActing } from '@/lib/console-client';

/** The dashboard page. */
export const CONSOLE_DASHBOARD_HREF = '/console/dashboard';
/** The caller's own organisation. */
export const CONSOLE_PROFILE_HREF = '/console/profile';
/** Keys the "Onboard participants" entry; the acting route answers with the page to open. */
const OWN_ONBOARDING_KEY = '/onboarding';

/**
 * Builds the console links for the actor and renders the shared sidebar.
 *
 * @param props.teamHref - The caller's team page, or `null` when it has no team to manage.
 * @param props.showProfile - The caller owns one organisation to show as its profile.
 * @param props.account - The account card: the admin's name and role.
 * @param props.ownCoordinatorAccountId - The owner's own coordinator account, from `read/me`; none hides "Onboard participants".
 */
export function ConsoleSidebar({
  teamHref,
  showProfile,
  account,
  ownCoordinatorAccountId = null,
}: Readonly<{
  teamHref: string | null;
  showProfile: boolean;
  account: SidebarAccount;
  ownCoordinatorAccountId?: string | null;
}>) {
  const t = useTranslations('console');
  const [actingError, setActingError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  /** Starts acting as the owner's own account, then opens its onboarding. */
  async function openOwnOnboarding(accountId: string) {
    if (starting) return;
    setStarting(true);
    setActingError(null);
    const r = await startActing(accountId);
    if (r.ok) {
      // A full page load: the session changed, so the coordinator shell renders fresh.
      window.location.assign(r.data.redirect);
      return;
    }
    setStarting(false);
    setActingError(r.error.code === ACTING_NOT_READY ? t('nav.acting_not_ready') : t(errorKey(r)));
  }
  const nav: NavItem[] = [
    { to: CONSOLE_DASHBOARD_HREF, label: t('nav.dashboard'), icon: 'trending' as const },
    ...(teamHref
      ? [
          {
            to: teamHref,
            label: t('nav.my_team'),
            icon: 'users' as const,
            exact: teamHref === '/console',
            section: t('nav.my_blue_dots'),
            sectionIcon: 'globe' as const,
          },
        ]
      : []),
    { to: '/console/orgs', label: t('nav.organisations'), icon: 'briefcase' as const },
    ...(showProfile
      ? [{ to: CONSOLE_PROFILE_HREF, label: t('nav.profile'), icon: 'user' as const }]
      : []),
    ...(ownCoordinatorAccountId
      ? [
          {
            to: OWN_ONBOARDING_KEY,
            label: t('nav.onboard_participants'),
            icon: 'upload' as const,
            section: t('nav.my_onboarding'),
            sectionIcon: 'external' as const,
            onSelect: () => void openOwnOnboarding(ownCoordinatorAccountId),
            alert: actingError,
          },
        ]
      : []),
  ];
  return (
    <AppSidebar
      nav={nav}
      overviewLabel={false}
      portalLabel={t('nav.portal_label')}
      account={account}
    />
  );
}
