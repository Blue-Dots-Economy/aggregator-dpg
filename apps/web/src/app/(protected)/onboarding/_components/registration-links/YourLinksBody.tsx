'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRegistrationLinks } from '@/hooks/useOnboarding';
import { useProfileRaw } from '@/hooks/useProfile';
import { useAggregatorConfig } from '@/hooks/useAggregatorConfig';
import { LinkCard } from './LinkCard';
import { SuccessToast } from './SuccessToast';

/** Height of the scrolling links list, about two and a half cards. */
const LINKS_LIST_MAX_HEIGHT_PX = 300;

/**
 * "Your Registration Links" list body, without an outer card.
 *
 * Render it inside a parent card.
 */
export function YourLinksBody() {
  const t = useTranslations('onboarding');
  // `?new=<link_id>` is set by the create flow to highlight the new draft.
  const newLinkId = useSearchParams().get('new');
  // Show the create confirmation here, after navigation from the create page.
  const [dismissedLinkId, setDismissedLinkId] = useState<string | null>(null);
  const toast = newLinkId && newLinkId !== dismissedLinkId ? t('your_links.draft_created') : null;
  const rawProfile = useProfileRaw();
  const { data: cfg } = useAggregatorConfig();
  // Aggregator's domain; the network's first domain until the profile loads.
  const aggregatorType: string = rawProfile.data?.type ?? cfg?.domains[0]?.id ?? '';
  // Links are filtered to the aggregator's registered type.
  const { data, isLoading, error } = useRegistrationLinks(aggregatorType);
  const links = data ?? [];
  const activeCount = links.filter((l) => l.status === 'live').length;

  let list;
  if (isLoading) {
    list = (
      <div className="text-center py-8 text-ink-400 text-[13px]">{t('your_links.loading')}</div>
    );
  } else if (error) {
    list = <div className="text-center py-8 text-rose-600 text-[13px]">{error.message}</div>;
  } else if (links.length === 0) {
    list = (
      <div className="text-center py-8 text-ink-400 text-[13px]">
        {t('your_links.empty', { type: aggregatorType })}
      </div>
    );
  } else {
    list = links.map((l) => (
      <LinkCard key={l.link_id} link={l} highlight={l.link_id === newLinkId} />
    ));
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-display font-bold text-[14px] text-ink-700">
            {t('your_links.title')}
          </div>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-semibold">
            {t('your_links.active_count', { count: activeCount })}
          </span>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-ink-50 text-ink-600 text-[11px] font-semibold capitalize">
            {t('your_links.type_pill', { type: aggregatorType })}
          </span>
        </div>
      </div>
      <div
        className="flex flex-col gap-3 overflow-y-auto pr-1"
        style={{ maxHeight: LINKS_LIST_MAX_HEIGHT_PX }}
      >
        {list}
      </div>
      {toast && (
        <SuccessToast
          key={newLinkId}
          message={toast}
          onDone={() => setDismissedLinkId(newLinkId)}
        />
      )}
    </div>
  );
}
