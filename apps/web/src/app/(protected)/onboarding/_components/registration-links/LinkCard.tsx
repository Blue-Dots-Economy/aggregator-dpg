'use client';

import { useState } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { useActivateLink, useDeactivateLink, useUpdateLink } from '@/hooks/useOnboarding';
import type { ApiRegistrationLink } from '@/services/onboarding.service';
import { LinkEditForm, useLinkEditForm } from './LinkEditForm';
import { LinkPublicUrl } from './LinkPublicUrl';
import { useHighlightOnMount } from './useHighlightOnMount';

/** Pill and dot colours per link status. */
const STATUS_STYLE: Record<string, { pill: string; dot: string }> = {
  live: { pill: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  retired: { pill: 'bg-rose-50 text-rose-700', dot: 'bg-rose-500' },
};
const DRAFT_STATUS_STYLE = { pill: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' };

/** Date format for the created and expiry dates. */
const CARD_DATE_FORMAT = { day: '2-digit', month: 'short', year: 'numeric' } as const;

/** Props for {@link LinkCard}. */
export interface LinkCardProps {
  link: ApiRegistrationLink;
  /** True for a just-created link (`?new=`); scrolls to and highlights it. */
  highlight?: boolean;
}

/**
 * One registration link: status, public URL (live), counts, and its actions.
 *
 * Drafts can be edited inline and made live; live links can be deactivated.
 */
export function LinkCard({ link, highlight = false }: Readonly<LinkCardProps>) {
  const t = useTranslations('onboarding');
  const format = useFormatter();
  const [editing, setEditing] = useState(false);
  const { cardRef, ringed } = useHighlightOnMount(highlight);
  const activate = useActivateLink();
  const deactivate = useDeactivateLink();
  const update = useUpdateLink();
  const edit = useLinkEditForm(link, update);
  const isLive = link.status === 'live';
  const isDraft = link.status === 'draft';
  const badge = STATUS_STYLE[link.status] ?? DRAFT_STATUS_STYLE;
  const ctx = link.context;
  const created = format.dateTime(new Date(link.created_at), CARD_DATE_FORMAT);
  const title =
    (typeof ctx['title'] === 'string' && ctx['title']) ||
    [ctx['district'], ctx['lever_event']].filter(Boolean).join(' ') ||
    link.slug;
  const subtitle =
    [ctx['org_name'], ctx['event_location']].filter(Boolean).join(' · ') ||
    `${t('link_card.created_prefix')} ${created}`;

  return (
    <div
      ref={cardRef}
      className={`bd-card p-5 hover:border-(--bd-primary-100) transition-all ${
        ringed ? 'ring-2 ring-primary-400 ring-offset-2' : ''
      }`}
    >
      {/* Actions stack under the card body below `sm`. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display font-bold text-[16px] text-ink-900 leading-tight">
              {title}
            </h3>
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${badge.pill}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full inline-block ${badge.dot}`} />
              {isLive ? t('link_card.active') : link.status}
            </span>
          </div>

          <p className="text-[12.5px] text-ink-400 mt-1.5">{subtitle}</p>

          {/* Public URL and QR only for live links; drafts have a null public_url. */}
          {isLive && link.public_url && (
            <LinkPublicUrl publicUrl={link.public_url} slug={link.slug} />
          )}

          {isDraft && !editing && (
            <div className="mt-3 text-[12.5px] text-ink-400">{t('link_card.draft_notice')}</div>
          )}

          <div className="flex items-center gap-4 mt-3.5 text-[12.5px] flex-wrap">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-[11.5px] ${
                link.domain === 'seeker' ? 'bg-amber-50 text-amber-700' : 'bg-sky-50 text-sky-700'
              }`}
            >
              {link.domain}
            </span>
            <span className="text-ink-700">
              <strong className="font-bold">{link.metrics?.total ?? 0}</strong>{' '}
              <span className="text-ink-400">{t('link_card.registrations')}</span>
            </span>
            <span className="text-ink-700">
              <strong className="font-bold">{link.metrics?.passed ?? 0}</strong>{' '}
              <span className="text-ink-400">{t('link_card.verified')}</span>
            </span>
            <span className="text-ink-400">
              {t('link_card.created_prefix')} {created}
            </span>
            {link.expires_at && (
              <span className="text-ink-400">
                {t('link_card.expires_prefix')}{' '}
                {format.dateTime(new Date(link.expires_at), CARD_DATE_FORMAT)}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {isDraft && !editing && (
            <Button kind="ghost" onClick={() => setEditing(true)} disabled={update.isPending}>
              {t('link_card.edit')}
            </Button>
          )}
          {isDraft && (
            <Button
              onClick={() => activate.mutate(link.link_id)}
              disabled={activate.isPending || editing || update.isPending}
            >
              {activate.isPending ? t('link_card.going_live') : t('link_card.make_live')}
            </Button>
          )}
          {isLive && (
            <Button
              kind="ghost"
              onClick={() => deactivate.mutate(link.link_id)}
              disabled={deactivate.isPending}
            >
              {deactivate.isPending ? t('link_card.retiring') : t('link_card.deactivate')}
            </Button>
          )}
        </div>
      </div>

      {isDraft && editing && <LinkEditForm edit={edit} onClose={() => setEditing(false)} />}
    </div>
  );
}
