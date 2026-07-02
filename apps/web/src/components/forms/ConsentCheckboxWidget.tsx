'use client';
/**
 * RJSF widget for the consent checkbox that renders clickable Terms of Service
 * and Privacy Policy links.
 *
 * Reads consent content from `formContext.consentContent`. When content is
 * present the labels are interactive buttons that open {@link ConsentModal} on
 * the relevant tab. Falls back to plain non-interactive text when
 * `consentContent` is absent (e.g. when `loadConsentConfig` failed at boot).
 *
 * Register as `"ConsentCheckbox"` in the RJSF widget map and set
 * `"ui:widget": "ConsentCheckbox"` on the `consent.value` field.
 *
 * @module apps/web/src/components/forms/ConsentCheckboxWidget
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { WidgetProps } from '@rjsf/utils';
import { ConsentModal } from '../consent/ConsentModal';
import type { ConsentTab } from '../consent/ConsentModal';
import type { ConsentDocContent } from '../consent/consent-types';

/**
 * Renders the registration consent checkbox with clickable Terms/Privacy links.
 *
 * Pulls `consentContent` from `formContext` so it can be passed server-side
 * from the page without threading extra props through RJSF field wiring. The
 * checkbox state is controlled by RJSF via `value`/`onChange`.
 *
 * @param props - Standard RJSF WidgetProps; uses `id`, `value`, `required`,
 *   `disabled`, `readonly`, `onChange`, and `formContext.consentContent`.
 * @returns The checkbox with linked label and (when content available) a
 *   read-only consent modal.
 */
export function ConsentCheckboxWidget(props: WidgetProps): JSX.Element {
  const { id, value, required, disabled, readonly, onChange, formContext } = props;
  const t = useTranslations('register');
  const [modalOpen, setModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ConsentTab>('terms');

  const consentContent = (formContext as Record<string, unknown> | undefined)?.consentContent as
    | ConsentDocContent
    | undefined;

  const openTab = (tab: ConsentTab): void => {
    setActiveTab(tab);
    setModalOpen(true);
  };

  const label = consentContent ? (
    <span className="text-[13.5px] text-ink-700 leading-relaxed">
      {t('consent.accept_prefix')}
      <button
        type="button"
        className="text-primary-600 underline hover:text-primary-700 cursor-pointer"
        onClick={() => openTab('privacy')}
      >
        {t('consent.privacy_link')}
      </button>
      {t('consent.and')}
      <button
        type="button"
        className="text-primary-600 underline hover:text-primary-700 cursor-pointer"
        onClick={() => openTab('terms')}
      >
        {t('consent.terms_link')}
      </button>
    </span>
  ) : (
    <span className="text-[13.5px] text-ink-700 leading-relaxed">
      {t('consent.accept_prefix')}
      {t('consent.privacy_link')}
      {t('consent.and')}
      {t('consent.terms_link')}
    </span>
  );

  return (
    <>
      <label className="flex items-start gap-3 py-2 cursor-pointer">
        <input
          id={id}
          type="checkbox"
          className="w-[18px] h-[18px] rounded-[5px] mt-0.5 accent-[var(--bd-primary)]"
          checked={Boolean(value)}
          required={required}
          disabled={disabled || readonly}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      {consentContent && (
        <ConsentModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          initialTab={activeTab}
          content={consentContent}
        />
      )}
    </>
  );
}
