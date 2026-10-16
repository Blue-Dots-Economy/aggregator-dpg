'use client';

/**
 * The organisation console's sidebar (user & org Phase 5), in the same shell
 * as the coordinator portal's ({@link AppSidebar}). The organisations list is
 * the network admin's only; coordinators and invites need `org.manage`, and
 * the read-only roles and permissions view `network.administer` (RBAC; the
 * API also checks them).
 */

import { useTranslations } from 'next-intl';
import { AppSidebar, type NavItem, type SidebarAccount } from '../shell/Sidebar';

/**
 * Builds the console links for the actor and renders the shared sidebar.
 *
 * @param props.isNetworkAdmin - The root organisation's owner.
 * @param props.canManage - Holds `org.manage` (coordinators, invites).
 * @param props.canViewAccess - May open the roles and permissions view.
 * @param props.account - The account card: the admin's name and role.
 */
export function ConsoleSidebar({
  isNetworkAdmin,
  canManage = true,
  canViewAccess = false,
  account,
}: {
  isNetworkAdmin: boolean;
  canManage?: boolean;
  canViewAccess?: boolean;
  account: SidebarAccount;
}) {
  const t = useTranslations('console');
  const nav: NavItem[] = [
    { to: '/console', label: t('nav.home'), icon: 'trending', exact: true },
    ...(isNetworkAdmin
      ? [{ to: '/console/orgs', label: t('nav.organisations'), icon: 'briefcase' as const }]
      : []),
    ...(canManage
      ? [
          { to: '/console/coordinators', label: t('nav.coordinators'), icon: 'users' as const },
          { to: '/console/invite', label: t('nav.invite'), icon: 'mail' as const },
        ]
      : []),
    ...(canViewAccess
      ? [
          {
            to: '/console/access/roles',
            match: '/console/access',
            label: t('nav.access'),
            icon: 'shield' as const,
          },
        ]
      : []),
    { to: '/console/account', label: t('nav.account'), icon: 'user' },
  ];
  return <AppSidebar nav={nav} portalLabel={t('nav.portal_label')} account={account} />;
}
