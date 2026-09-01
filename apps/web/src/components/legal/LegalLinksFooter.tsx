'use client';

/**
 * The Privacy / Terms links shown at the foot of the public surfaces.
 *
 * One component for all three (login, org registration, the public QR form)
 * because the styling is the whole point: these had been muted `text-ink-500`
 * with `hover:underline`, so they read as ordinary prose until you happened to
 * hover them. A link that only announces itself on hover is not discoverable by
 * touch at all. They now carry the brand colour and a permanent underline, the
 * same treatment as the sibling Signals portal's own footer.
 *
 * Both documents live on one page, so each link is a fragment of `/legal`.
 *
 * @module components/legal/LegalLinksFooter
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { JSX, ReactNode } from 'react';

/** Shared link chrome — the reason this component exists. */
const LINK_CLASS =
  'font-medium text-(--bd-primary-600) underline underline-offset-2 transition-opacity hover:opacity-80';

interface LegalLinksFooterProps {
  /**
   * `sentence` — "By continuing you agree to the Privacy Policy and Terms.",
   * for a surface where continuing IS the act of agreeing (the login page).
   *
   * `separated` — "Privacy Policy · Terms of Service", for a surface that
   * already captures consent explicitly and just needs the documents reachable.
   */
  variant: 'sentence' | 'separated';
  className?: string;
}

export function LegalLinksFooter({
  variant,
  className,
}: Readonly<LegalLinksFooterProps>): JSX.Element {
  const t = useTranslations('legal');
  const tRegister = useTranslations('register');

  const privacy = (
    <Link href="/legal#privacy" className={LINK_CLASS}>
      {tRegister('consent.privacy_link')}
    </Link>
  );
  const terms = (
    <Link href="/legal#terms" className={LINK_CLASS}>
      {tRegister('consent.terms_link')}
    </Link>
  );

  if (variant === 'separated') {
    return (
      <div
        className={`flex items-center justify-center gap-3 text-[12.5px] text-ink-500 ${className ?? ''}`}
      >
        {privacy}
        <span aria-hidden="true">·</span>
        {terms}
      </div>
    );
  }

  return (
    <p className={`text-[12px] text-ink-500 ${className ?? ''}`}>
      {/* `t.rich`, not string concatenation: where the links sit inside the
          sentence differs by language, and only the translator can decide that.
          Hindi and Kannada both put the verb last, so a hardcoded
          "prefix + link + and + link" would read wrong in each. */}
      {t.rich('agree_sentence', {
        privacy: (chunks: ReactNode) => (
          <Link href="/legal#privacy" className={LINK_CLASS}>
            {chunks}
          </Link>
        ),
        terms: (chunks: ReactNode) => (
          <Link href="/legal#terms" className={LINK_CLASS}>
            {chunks}
          </Link>
        ),
      })}
    </p>
  );
}
