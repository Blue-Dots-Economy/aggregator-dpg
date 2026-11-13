'use client';

/**
 * The organisation console's sidebar, in the same shell as the coordinator
 * portal's ({@link AppSidebar}): Dashboard, My Team under My Blue Dots,
 * Onboarded Organisations and Profile. My Team needs `org.manage` in an owned
 * organisation (the API also checks it), so the network admin has none; Profile
 * is the caller's own organisation. "My account" opens from the account card
 * at the foot of the sidebar (`SidebarAccount.details`).
 */

import { useTranslations } from 'next-intl';
import { AppSidebar, type NavItem, type SidebarAccount } from '../shell/Sidebar';

/** The dashboard page. */
export const CONSOLE_DASHBOARD_HREF = '/console/dashboard';
/** The caller's own organisation. */
export const CONSOLE_PROFILE_HREF = '/console/profile';

/**
 * Builds the console links for the actor and renders the shared sidebar.
 *
 * @param props.teamHref - The caller's team page, or `null` when it has no team to manage.
 * @param props.showProfile - The caller owns one organisation to show as its profile.
 * @param props.account - The account card: the admin's name and role.
 */
export function ConsoleSidebar({
  teamHref,
  showProfile,
  account,
}: Readonly<{
  teamHref: string | null;
  showProfile: boolean;
  account: SidebarAccount;
}>) {
  const t = useTranslations('console');
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
          },
        ]
      : []),
    { to: '/console/orgs', label: t('nav.organisations'), icon: 'briefcase' as const },
    ...(showProfile
      ? [{ to: CONSOLE_PROFILE_HREF, label: t('nav.profile'), icon: 'user' as const }]
      : []),
  ];
  return <AppSidebar nav={nav} portalLabel={t('nav.portal_label')} account={account} />;
}
