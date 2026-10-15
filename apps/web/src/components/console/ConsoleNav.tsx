'use client';

/**
 * Console navigation (user & org Phase 5). The organisations list is the
 * network admin's only; coordinators and invites need `org.manage`, and the
 * read-only roles and permissions view `network.administer` (RBAC; the API
 * also checks them).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '../../lib/cn';

export function ConsoleNav({
  isNetworkAdmin,
  canManage = true,
  canViewAccess = false,
}: Readonly<{
  isNetworkAdmin: boolean;
  canManage?: boolean;
  canViewAccess?: boolean;
}>) {
  const t = useTranslations('console');
  const path = usePathname() ?? '';
  const items = [
    { to: '/console', label: t('nav.home') },
    ...(isNetworkAdmin ? [{ to: '/console/orgs', label: t('nav.organisations') }] : []),
    ...(canManage
      ? [
          { to: '/console/coordinators', label: t('nav.coordinators') },
          { to: '/console/invite', label: t('nav.invite') },
        ]
      : []),
    ...(canViewAccess
      ? [{ to: '/console/access/roles', match: '/console/access', label: t('nav.access') }]
      : []),
    { to: '/console/account', label: t('nav.account') },
  ];
  const active = (to: string) => (to === '/console' ? path === to : path.startsWith(to));
  const isActive = (i: { to: string; match?: string }) => active(i.match ?? i.to);
  return (
    <nav
      aria-label={t('title')}
      className="lg:w-60 shrink-0 border-b lg:border-b-0 lg:border-r border-(--bd-border) bg-white px-4 py-4"
    >
      <p className="font-display font-bold text-[16px] text-ink-900 mb-3">{t('title')}</p>
      <ul className="flex lg:flex-col gap-1 flex-wrap">
        {items.map((i) => (
          <li key={i.to}>
            <Link
              href={i.to}
              aria-current={isActive(i) ? 'page' : undefined}
              className={cn(
                'block rounded-[8px] px-3 py-2 text-[13.5px]',
                isActive(i)
                  ? 'bg-(--bd-primary-50) text-primary-600 font-semibold'
                  : 'text-ink-700 hover:bg-ink-50',
              )}
            >
              {i.label}
            </Link>
          </li>
        ))}
        <li>
          <a
            href="/api/auth/logout"
            className="block rounded-[8px] px-3 py-2 text-[13.5px] text-ink-700 hover:bg-ink-50"
          >
            {t('nav.sign_out')}
          </a>
        </li>
      </ul>
    </nav>
  );
}
