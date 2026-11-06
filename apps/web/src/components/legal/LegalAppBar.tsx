/**
 * The app bar on the public legal page: brand logo, a back link to sign-in,
 * and the language and theme controls. It spans the full width and sticks to
 * the top. Its fixed `h-14` matches the rail's `md:top-14`. It does not read
 * `useAuth`, because the page is public.
 */

import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { BlueDotsLogo } from '@/components/ui/BlueDotsLogo';
import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '@/hooks/useAggregatorConfig';
import { useThemeMode } from '@/lib/theme-mode';
import { I } from '@/icons';

/** The sticky app bar above the rail and the reading column. */
export function LegalAppBar() {
  const t = useTranslations('legal');
  const themeT = useTranslations('theme');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const { mode, toggle: toggleTheme } = useThemeMode();
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-(--bd-border) bg-(--bd-card) px-4 sm:px-6">
      {cfg.brand.logo?.default ? (
        <Image
          src={cfg.brand.logo.default}
          alt={cfg.brand.short_name}
          width={160}
          height={40}
          priority
          className="h-9 w-auto shrink-0 object-contain object-left"
        />
      ) : (
        <div className="flex min-w-0 shrink-0 items-center gap-2.5">
          <BlueDotsLogo size={36} />
          <span className="truncate font-display text-[15px] font-bold leading-tight text-ink-900">
            {cfg.brand.short_name}
          </span>
        </div>
      )}

      <Link
        href="/login"
        aria-label={t('back_to_sign_in')}
        className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-ink-500 transition-colors hover:text-(--bd-primary-600)"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">{t('back_to_sign_in')}</span>
      </Link>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <LanguageSwitcher />
        <button
          type="button"
          onClick={toggleTheme}
          title={mode === 'dark' ? themeT('switch_to_light') : themeT('switch_to_dark')}
          aria-label={themeT('toggle_aria')}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-(--bd-border) bg-(--bd-card) text-(--bd-fg-muted) transition-colors hover:bg-(--bd-border-soft) hover:text-(--bd-fg)"
        >
          {mode === 'dark' ? <I.sun size={16} /> : <I.moon size={16} />}
        </button>
      </div>
    </header>
  );
}
