/** The side card on the invite page: the three steps and the per-send limit. */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Check, FileText, Mail } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ConsoleSection } from '@/components/console/ConsoleUi';

/** The steps in the help card, in order. The first is the sender's own step. */
const HELP_STEPS = [
  { key: 'send', Icon: Mail },
  { key: 'register', Icon: FileText },
  { key: 'approve', Icon: Check },
] as const;

/** Renders a `<link>` chunk as a link to `href`, or as plain text without one. */
function linkTo(href: string | null) {
  return function renderLink(chunks: ReactNode) {
    if (!href) return chunks;
    return (
      <Link href={href} className="font-semibold text-(--bd-primary-600) hover:underline">
        {chunks}
      </Link>
    );
  };
}

/** The side card: the three steps, a link to Coordinators, and the per-send limit. */
export function HelpCard({
  maxRecipients,
  coordinatorsHref,
}: Readonly<{ maxRecipients: number; coordinatorsHref: string | null }>) {
  const t = useTranslations('console');
  return (
    <ConsoleSection flush>
      <aside aria-labelledby="invite-help-heading">
        <div className="p-5">
          <h2
            id="invite-help-heading"
            className="mb-3.5 text-[13px] font-bold uppercase tracking-[0.08em] text-ink-500"
          >
            {t('invite.help.heading')}
          </h2>
          <ol className="flex flex-col">
            {HELP_STEPS.map(({ key, Icon }, i) => (
              <li
                key={key}
                className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-3 pb-[18px] last:pb-0"
              >
                {i < HELP_STEPS.length - 1 ? (
                  <span
                    aria-hidden
                    className="absolute bottom-0.5 left-[15px] top-[34px] w-0.5 bg-(--bd-border)"
                  />
                ) : null}
                <span
                  className={cn(
                    'grid h-8 w-8 place-items-center rounded-full',
                    i === 0
                      ? 'bg-(--bd-primary) text-white'
                      : 'bg-(--bd-primary-50) text-(--bd-primary-600)',
                  )}
                >
                  <Icon className="h-[15px] w-[15px]" />
                </span>
                <span className="min-w-0">
                  <span className="block pt-[5px] text-[13.5px] font-bold text-ink-900">
                    {t(`invite.help.${key}.title`)}
                  </span>
                  <span className="block text-[13px] text-ink-500">
                    {key === 'approve'
                      ? t.rich('invite.help.approve.body', { link: linkTo(coordinatorsHref) })
                      : t(`invite.help.${key}.body`)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <p className="border-t border-(--bd-border-soft) px-5 py-3.5 text-[12px] text-ink-500">
          {t('invite.help.limits', { max: maxRecipients })}
        </p>
      </aside>
    </ConsoleSection>
  );
}
