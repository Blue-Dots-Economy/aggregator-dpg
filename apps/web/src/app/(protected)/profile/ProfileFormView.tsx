'use client';

import { useMemo } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { Topbar } from '../../../components/shell/Topbar';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import { useProfileRaw } from '../../../hooks/useProfile';
import { I } from '../../../icons';
import type { ProfileApiResponse } from '../../../services/profile.service';

/**
 * Read-only aggregator profile view (issue #470).
 *
 * Renders the *same* form the public registration page renders — the schema is
 * loaded server-side and passed in — populated with the signed-in aggregator's
 * stored profile, with every field disabled. The registration-only consent
 * block is hidden (a signup-time legal artifact, not editable profile data) and
 * the submit button is suppressed, so the page can never be updated here.
 */

export interface ProfileFormViewProps {
  /** Registration JSON Schema (shared with `/register`). */
  schema: RJSFSchema;
  /** Registration RJSF UI schema (shared with `/register`). */
  uiSchema: Record<string, unknown>;
}

/**
 * Maps the merged profile API response into the registration schema's form
 * shape. Only the fields the registration schema declares are carried across;
 * post-login extras (personas, services) are intentionally omitted so the two
 * surfaces render identically.
 *
 * @param api - The merged `GET /v1/aggregators/profile/me` response.
 * @returns Form data keyed to the registration schema properties.
 */
function toFormData(api: ProfileApiResponse): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (api.org_name) data['name'] = api.org_name;
  if (api.type) data['type'] = api.type;
  if (api.url) data['url'] = api.url;
  if (api.contact) {
    data['contact'] = {
      name: api.contact.name,
      phone: api.contact.phone,
      email: api.contact.email,
    };
  }
  if (Array.isArray(api.locations) && api.locations.length > 0) {
    data['locations'] = api.locations;
  }
  return data;
}

export function ProfileFormView({ schema, uiSchema }: ProfileFormViewProps): JSX.Element {
  const t = useTranslations('profile.view');
  const { data, isLoading, isError } = useProfileRaw();

  // Reuse the registration UI schema, but hide the consent block and suppress
  // the submit button — the profile is display-only.
  const readonlyUiSchema = useMemo<Record<string, unknown>>(
    () => ({
      ...uiSchema,
      'ui:submitButtonOptions': { norender: true },
      consent: {
        ...((uiSchema['consent'] as Record<string, unknown> | undefined) ?? {}),
        'ui:widget': 'hidden',
      },
    }),
    [uiSchema],
  );

  const formData = useMemo(() => (data ? toFormData(data) : {}), [data]);

  return (
    <div className="fade-up">
      <Topbar title={t('topbar_title')} subtitle={t('topbar_subtitle')} />

      <div className="bd-card bd-shadow overflow-hidden">
        <div className="px-7 py-4 bg-gradient-to-r from-[var(--bd-tint-primary)] to-[var(--bd-card)] border-b border-[var(--bd-border)] flex items-start gap-2.5">
          <I.lock size={16} className="text-primary-600 mt-0.5 shrink-0" />
          <p className="text-[12.5px] text-ink-500 leading-relaxed">{t('readonly_note')}</p>
        </div>

        <div className="px-7 py-7">
          {isLoading ? (
            <div className="text-center text-ink-400 text-[13.5px] py-6">{t('loading')}</div>
          ) : isError ? (
            <div className="rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3">
              <div className="font-display font-bold text-[15px] text-rose-700">
                {t('error_load_title')}
              </div>
              <div className="text-[13px] text-rose-600 mt-1">{t('error_load_detail')}</div>
            </div>
          ) : (
            <RjsfThemedForm
              schema={schema}
              uiSchema={readonlyUiSchema as unknown as UiSchema<Record<string, unknown>>}
              formData={formData}
              readonly
            >
              {/* Empty children suppress RJSF's default submit button. */}
              <></>
            </RjsfThemedForm>
          )}
        </div>
      </div>
    </div>
  );
}
