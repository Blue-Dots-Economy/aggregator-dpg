'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { SubmitBlockers } from '@/components/ui/SubmitBlockers';
import { I } from '@/icons';
import { useCreateLink } from '@/hooks/useOnboarding';
import { useProfile, useProfileRaw } from '@/hooks/useProfile';
import { useAggregatorConfig } from '@/hooks/useAggregatorConfig';
import { buildLinkSlug, buildLinkTitle, failureText, parseTags } from './link-form';
import { LinkField } from './LinkField';
import { SuccessToast } from './SuccessToast';
import { useCreateLinkForm } from './useCreateLinkForm';

/**
 * Create-link form of the registration links page.
 *
 * Creates a draft link for the aggregator's registered domain, then opens the
 * onboarding overview with `?new=` so the list highlights the new draft.
 */
export function CreateLinkSection() {
  const t = useTranslations('onboarding');
  // Root translator for registration mode keys from network config.
  const tRoot = useTranslations();
  const router = useRouter();
  const [createError, setCreateError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const create = useCreateLink();
  const profile = useProfile();
  const rawProfile = useProfileRaw();
  const orgName = profile.data?.org ?? '';
  // The aggregator's registered type. The API rejects other domains.
  const domain = rawProfile.data?.type ?? '';
  const { data: cfg } = useAggregatorConfig();
  const registrationModes = cfg?.registration_modes ?? {};
  const {
    values: form,
    setField,
    reset,
  } = useCreateLinkForm({
    address: rawProfile.data?.locations?.[0]?.address,
    modeKeys: Object.keys(registrationModes),
  });
  const domainCfg = cfg?.domains?.find((d) => d.id === domain);
  // Label for the read-only Domain field, from network config.
  const domainLabel = domainCfg?.plural_label ?? domainCfg?.label ?? domain;
  // Caption listing every configured domain, e.g. "Seekers / Providers".
  const domainsCaption =
    (cfg?.domains ?? []).map((d) => d.plural_label ?? d.label ?? d.id).join(' / ') ||
    t('create_link.field_domain');

  // Missing required fields, listed under the disabled create button.
  const createBlockers: string[] = [];
  if (!form.state) createBlockers.push(t('create_link.blockers.state'));
  if (!form.district) createBlockers.push(t('create_link.blockers.district'));
  if (!form.lever_event) createBlockers.push(t('create_link.blockers.lever_event'));
  if (!domain) createBlockers.push(t('create_link.blockers.domain'));
  if (!form.registration_mode) createBlockers.push(t('create_link.blockers.registration_mode'));

  const onCreate = async () => {
    // The Create button is disabled while `createBlockers` is non-empty.
    setCreateError(null);
    try {
      const title = buildLinkTitle(form);
      const slug = buildLinkSlug(form);
      const tags = parseTags(form.tags);
      const created = await create.mutateAsync({
        domain,
        status: 'draft',
        registration_mode: form.registration_mode,
        ...(slug ? { slug } : {}),
        title,
        context: {
          org_name: orgName || undefined,
          title,
          state: form.state || undefined,
          district: form.district || undefined,
          lever_event: form.lever_event || undefined,
          event_date: form.event_date || undefined,
          event_location: form.event_location || undefined,
          ...(tags.length > 0 ? { tags } : {}),
        },
      });
      // Reset the form. `?new=` tells the links list to scroll to and highlight the new draft.
      reset();
      setToast(t('create_link.link_created'));
      router.push(`/onboarding?new=${encodeURIComponent(created.link_id)}`);
    } catch (err) {
      setCreateError(failureText(err));
    }
  };

  return (
    <div className="bd-card bd-shadow overflow-hidden">
      <div className="px-6 py-5 flex flex-wrap items-center gap-3 border-b border-(--bd-border)">
        <I.link size={16} className="text-ink-500" />
        <div className="font-display font-bold text-[16px] text-ink-900">
          {t('create_link.title')}
        </div>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11.5px] font-semibold">
          <span className="relative w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block">
            <span className="absolute inset-0 rounded-full bg-emerald-500 opacity-40 animate-pulse-dot" />
          </span>
          {t('create_link.new_badge')}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px]">
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <LinkField label={t('create_link.field_org_name')}>
              <input
                className="bd-input bg-ink-50 cursor-not-allowed"
                value={orgName}
                readOnly
                placeholder="—"
              />
            </LinkField>
          </div>
          <LinkField label={t('create_link.field_state')} required>
            <input
              className="bd-input"
              value={form.state}
              onChange={(e) => setField('state', e.target.value)}
              placeholder={t('create_link.placeholder_state')}
            />
          </LinkField>
          <LinkField label={t('create_link.field_event')} required>
            <input
              className="bd-input"
              value={form.lever_event}
              onChange={(e) => setField('lever_event', e.target.value)}
              placeholder={t('create_link.placeholder_event')}
            />
          </LinkField>
          <LinkField label={t('create_link.field_event_date')}>
            <input
              type="date"
              className="bd-input"
              value={form.event_date}
              onChange={(e) => setField('event_date', e.target.value)}
            />
          </LinkField>
          <LinkField label={t('create_link.field_event_location')}>
            <input
              className="bd-input"
              value={form.event_location}
              onChange={(e) => setField('event_location', e.target.value)}
              placeholder={t('create_link.placeholder_location')}
            />
          </LinkField>
          <LinkField label={t('create_link.field_district')} required>
            <input
              className="bd-input"
              value={form.district}
              onChange={(e) => setField('district', e.target.value)}
              placeholder={t('create_link.placeholder_district')}
            />
          </LinkField>
          <LinkField label={domainsCaption} required>
            {/* Read-only: set to the aggregator's registered type. */}
            <input className="bd-input" value={domainLabel} readOnly aria-readonly="true" />
          </LinkField>
          {/*
           * Registration mode, set at create time and fixed afterwards. Options
           * come from the network config's `registration_modes`. The mode's
           * `public_hint_i18n_key` is for the public form, so it is not shown here.
           */}
          <LinkField label={t('create_link.field_registration_mode')} required>
            <select
              className="bd-input"
              value={form.registration_mode}
              onChange={(e) => setField('registration_mode', e.target.value)}
            >
              {Object.entries(registrationModes).map(([key, mode]) => (
                <option key={key} value={key}>
                  {tRoot(mode.label_i18n_key)}
                </option>
              ))}
            </select>
          </LinkField>
          <LinkField label={t('create_link.field_tags')}>
            <input
              className="bd-input"
              value={form.tags}
              onChange={(e) => setField('tags', e.target.value)}
              placeholder={t('create_link.placeholder_tags')}
            />
          </LinkField>
          {createBlockers.length > 0 && (
            <div className="md:col-span-2">
              <SubmitBlockers
                reasons={createBlockers}
                heading={t('create_link.blockers.heading')}
              />
            </div>
          )}
          <div className="md:col-span-2 flex items-center justify-end gap-2 mt-2 flex-wrap">
            <Button onClick={onCreate} disabled={create.isPending || createBlockers.length > 0}>
              {create.isPending ? t('create_link.creating') : t('create_link.create_button')}
            </Button>
          </div>
          {createError && (
            <div className="md:col-span-2 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-[10px] px-3 py-2">
              {createError}
            </div>
          )}
        </div>

        <div className="border-t lg:border-t-0 lg:border-l border-(--bd-border) bg-linear-to-b from-(--bd-tint-primary) to-(--bd-card) p-6 flex flex-col items-center text-center">
          <div className="flex items-center gap-2 self-start text-[12.5px] font-semibold text-ink-500">
            <I.qr size={14} /> {t('create_link.qr_label')}
          </div>
          <div className="mt-4 p-3 bg-white rounded-[14px] border border-(--bd-border) bd-shadow-lg">
            <div className="w-[200px] h-[200px] flex items-center justify-center text-ink-300 text-[12px] text-center px-4">
              {t('create_link.qr_placeholder')}
            </div>
          </div>
        </div>
      </div>
      {toast && <SuccessToast key={toast} message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
