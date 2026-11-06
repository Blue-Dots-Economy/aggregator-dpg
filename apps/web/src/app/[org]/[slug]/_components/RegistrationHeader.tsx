'use client';

import Image from 'next/image';
import type { JSX } from 'react';
import { BlueDotsLogo } from '@/components/ui/BlueDotsLogo';
import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher';

/** Props for {@link RegistrationHeader}. */
export interface RegistrationHeaderProps {
  brandShort: string;
  /** Brand logo URL; without one the Blue Dots mark and short name show. */
  brandLogo: string | undefined;
}

/**
 * Page header: brand logo or name, and the language switcher.
 */
export function RegistrationHeader({
  brandShort,
  brandLogo,
}: Readonly<RegistrationHeaderProps>): JSX.Element {
  return (
    <header className="flex items-center justify-between gap-4 mb-6">
      {brandLogo ? (
        <Image
          src={brandLogo}
          alt={brandShort}
          width={200}
          height={48}
          priority
          className="h-10 w-auto object-contain object-left"
        />
      ) : (
        <div className="flex items-center gap-3">
          <BlueDotsLogo size={40} />
          <div className="font-display font-bold text-[18px] text-ink-900 leading-none tracking-tight">
            {brandShort}
          </div>
        </div>
      )}
      <LanguageSwitcher />
    </header>
  );
}
