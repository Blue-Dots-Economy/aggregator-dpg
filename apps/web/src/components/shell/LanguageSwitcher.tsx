'use client';

import { useTransition } from 'react';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Languages } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { getEnabledLocales, LOCALE_NAMES } from '../../i18n/config';
import { setLocale } from '../../i18n/locale-cookie';

/**
 * Dropdown that switches the UI language. Options are rendered dynamically
 * from `NEXT_PUBLIC_ENABLED_LANGUAGES`; selecting one persists the choice to
 * the NEXT_LOCALE cookie and refreshes the route so server components re-render
 * in the new language. Hidden when fewer than two languages are enabled.
 */
export function LanguageSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const enabled = getEnabledLocales();

  if (enabled.length < 2) return null;

  function handleChange(next: string) {
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });
  }

  return (
    <Select value={locale} onValueChange={handleChange}>
      <SelectTrigger aria-label={LOCALE_NAMES_LABEL} className="w-auto gap-1.5 px-2.5 py-2">
        <Languages className="h-4 w-4 shrink-0 opacity-70" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {enabled.map((code) => (
          <SelectItem key={code} value={code}>
            {LOCALE_NAMES[code]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Accessible name for the trigger. Kept as a constant for now so the Task 5
// unit test stays isolated from the i18n provider; Task 6 swaps this for a
// useTranslations('language') -> t('label') call.
const LOCALE_NAMES_LABEL = 'Language';
