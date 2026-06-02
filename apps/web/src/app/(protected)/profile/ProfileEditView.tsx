'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import { Button } from '../../../components/ui/Button';
import { I } from '../../../icons';
import { useEditProfile, useProfileRaw } from '../../../hooks/useProfile';
import type { ProfileEditPayload } from '../../../services/profile.service';

/**
 * Edit-mode form for the aggregator profile. Pulls the canonical Beckn-shape
 * profile via `useProfileRaw`, hands it to RJSF, and PATCHes the split body
 * (`aggregator.*` + `profile.*`) on submit. `org_slug`, `status`,
 * `actor_type`, and the audit fields are read-only by design — the server
 * trigger / approval flow owns those.
 *
 * Personas + services use a comma-separated string input on the wire
 * (`"persona-iti-seeker:ITI Seeker, persona-pwd-seeker:PwD Seeker"`) so the
 * existing widgets can render them without bespoke chips. Stored shape on
 * the server is unchanged.
 */

interface EditFormState {
  // aggregator side
  name: string;
  url: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  contact_alternate_phone: string;
  // profile side
  profile_contact_name: string;
  personas: string; // "id:Name, id2:Name2"
  services: string;
  // first location (advanced multi-location editing deferred)
  loc_street: string;
  loc_city: string;
  loc_state: string;
  loc_postal: string;
  loc_country: string;
}

const EMPTY: EditFormState = {
  name: '',
  url: '',
  contact_name: '',
  contact_phone: '',
  contact_email: '',
  contact_alternate_phone: '',
  profile_contact_name: '',
  personas: '',
  services: '',
  loc_street: '',
  loc_city: '',
  loc_state: '',
  loc_postal: '',
  loc_country: 'IN',
};

/**
 * RJSF schema for the edit form. Intentionally flat (no nested `contact` /
 * `locations` objects on the wire shape) so the user sees one consistent
 * 2-column grid. Submit time reassembles into the API split body.
 */
const editSchema: RJSFSchema = {
  type: 'object',
  required: ['contact_phone', 'contact_email'],
  properties: {
    name: { type: 'string', title: 'Organisation Name' },
    url: { type: 'string', title: 'Website' },
    contact_name: { type: 'string', title: 'Contact Name (Beckn)' },
    contact_phone: {
      type: 'string',
      title: 'Phone',
      pattern: '^(\\+?\\d{10,15}|\\d{10})$',
    },
    contact_email: { type: 'string', title: 'Email', format: 'email' },
    contact_alternate_phone: { type: 'string', title: 'Alternate Phone' },
    profile_contact_name: {
      type: 'string',
      title: 'Primary Contact Label',
      description: 'Display label for the human contact at the aggregator org.',
    },
    personas: {
      type: 'string',
      title: 'Personas Supported',
      description:
        'Comma-separated `id:Name` pairs. e.g. `persona-iti-seeker:ITI Seeker, persona-pwd-seeker:PwD Seeker`.',
    },
    services: {
      type: 'string',
      title: 'Services Supported',
      description: 'Comma-separated `id:Name` pairs.',
    },
    loc_street: { type: 'string', title: 'Street' },
    loc_city: { type: 'string', title: 'City' },
    loc_state: { type: 'string', title: 'State' },
    loc_postal: { type: 'string', title: 'PIN code' },
    loc_country: { type: 'string', title: 'Country (ISO-2)', minLength: 2, maxLength: 2 },
  },
};

const editUiSchema: UiSchema = {
  'ui:order': [
    'name',
    'url',
    'contact_name',
    'contact_phone',
    'contact_email',
    'contact_alternate_phone',
    'profile_contact_name',
    'personas',
    'services',
    'loc_street',
    'loc_city',
    'loc_state',
    'loc_postal',
    'loc_country',
  ],
  name: { 'ui:readonly': true, 'ui:help': 'Organisation name is fixed after registration.' },
  url: { 'ui:placeholder': 'https://yourorg.in' },
  contact_phone: { 'ui:placeholder': '+91 98765 43210' },
  contact_email: { 'ui:placeholder': 'admin@yourorg.in' },
  contact_alternate_phone: { 'ui:placeholder': 'Optional' },
  personas: { 'ui:placeholder': 'persona-iti-seeker:ITI Seeker, persona-pwd-seeker:PwD Seeker' },
  services: { 'ui:placeholder': 'service-bluedots-job:BlueDots Job Posting' },
  loc_street: { 'ui:placeholder': 'Building / street' },
  loc_city: { 'ui:placeholder': 'City' },
  loc_state: { 'ui:placeholder': 'State' },
  loc_postal: { 'ui:placeholder': 'PIN' },
  loc_country: { 'ui:placeholder': 'IN' },
};

interface RawProfile {
  org_name: string;
  url: string | null;
  contact: {
    name: string;
    phone: string;
    email: string;
    alternatePhone?: string;
    company?: string;
    gstNumber?: string;
  };
  locations: Array<{
    geo: { type: string; coordinates?: unknown };
    address?: Record<string, string | undefined>;
  }>;
  contact_name: string | null;
  personas: Array<{ id: string; name: string }>;
  services: Array<{ id: string; name: string }>;
}

function rawToForm(raw: RawProfile): EditFormState {
  const first = raw.locations?.[0]?.address ?? {};
  return {
    name: raw.org_name ?? '',
    url: raw.url ?? '',
    contact_name: raw.contact?.name ?? '',
    contact_phone: raw.contact?.phone ?? '',
    contact_email: raw.contact?.email ?? '',
    contact_alternate_phone: raw.contact?.alternatePhone ?? '',
    profile_contact_name: raw.contact_name ?? '',
    personas: (raw.personas ?? []).map((p) => `${p.id}:${p.name}`).join(', '),
    services: (raw.services ?? []).map((s) => `${s.id}:${s.name}`).join(', '),
    loc_street: first.streetAddress ?? '',
    loc_city: first.addressLocality ?? '',
    loc_state: first.addressRegion ?? '',
    loc_postal: first.postalCode ?? '',
    loc_country: first.addressCountry ?? 'IN',
  };
}

function parseRefs(input: string): Array<{ id: string; name: string }> {
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx === -1) return { id: entry, name: entry };
      return { id: entry.slice(0, idx).trim(), name: entry.slice(idx + 1).trim() };
    })
    .filter((p) => p.id.length > 0 && p.name.length > 0);
}

function formToPayload(f: EditFormState): ProfileEditPayload {
  // name is read-only — never patched from edit form
  const aggregator: ProfileEditPayload['aggregator'] = {
    url: f.url.trim() === '' ? null : f.url,
    contact: {
      name: f.contact_name,
      phone: f.contact_phone,
      email: f.contact_email,
      ...(f.contact_alternate_phone ? { alternatePhone: f.contact_alternate_phone } : {}),
    },
  };
  const hasAddressFields =
    f.loc_street || f.loc_city || f.loc_state || f.loc_postal || f.loc_country;
  if (hasAddressFields) {
    aggregator.locations = [
      {
        geo: { type: 'Point', coordinates: [0, 0] },
        address: {
          ...(f.loc_street ? { streetAddress: f.loc_street } : {}),
          ...(f.loc_city ? { addressLocality: f.loc_city } : {}),
          ...(f.loc_state ? { addressRegion: f.loc_state } : {}),
          ...(f.loc_postal ? { postalCode: f.loc_postal } : {}),
          ...(f.loc_country ? { addressCountry: f.loc_country } : {}),
        },
      },
    ];
  }
  const profile: ProfileEditPayload['profile'] = {
    contact_name: f.profile_contact_name.trim() === '' ? null : f.profile_contact_name,
    personas: parseRefs(f.personas),
    services: parseRefs(f.services),
  };
  return { aggregator, profile };
}

interface ProfileEditViewProps {
  onDone: () => void;
  onSaved?: () => void;
}

export function ProfileEditView({ onDone, onSaved }: ProfileEditViewProps): JSX.Element {
  const t = useTranslations('profile.edit');
  const raw = useProfileRaw();
  const edit = useEditProfile();
  const [formData, setFormData] = useState<EditFormState>(EMPTY);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (raw.data) setFormData(rawToForm(raw.data as unknown as RawProfile));
  }, [raw.data]);

  const headingTagline = useMemo(() => t('tagline'), [t]);

  const handleSubmit = async (
    e: IChangeEvent<EditFormState>,
    _event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    setErrorMessage(null);
    const data = (e.formData ?? formData) as EditFormState;
    try {
      await edit.mutateAsync(formToPayload(data));
      onSaved?.();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t('btn_save'));
    }
  };

  if (raw.isLoading) {
    return (
      <div className="bd-card bd-shadow p-8 text-center text-ink-400 text-[13.5px]">
        {t('loading')}
      </div>
    );
  }
  if (raw.error) {
    return (
      <div className="bd-card bd-shadow p-6 border border-rose-200 bg-[var(--bd-tint-rose)]">
        <div className="font-display font-bold text-[15px] text-rose-700">
          {t('error_load_title')}
        </div>
        <div className="text-[13px] text-rose-600 mt-1">{(raw.error as Error).message}</div>
      </div>
    );
  }

  return (
    <div className="bd-card bd-shadow overflow-hidden">
      <div className="px-7 py-5 bg-gradient-to-r from-[var(--bd-tint-primary)] to-[var(--bd-card)] border-b border-[var(--bd-border)]">
        <h2 className="font-display font-bold text-[17px] text-ink-900">{t('heading')}</h2>
        <p className="text-[12.5px] text-ink-400 mt-0.5">{headingTagline}</p>
      </div>

      <div className="px-7 py-7">
        {errorMessage && (
          <div className="mb-4 rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">
            {errorMessage}
          </div>
        )}
        <RjsfThemedForm<EditFormState>
          schema={editSchema}
          uiSchema={editUiSchema}
          formData={formData}
          onChange={(e) => setFormData(e.formData as EditFormState)}
          onSubmit={handleSubmit}
          showErrorList={false}
          focusOnFirstError
          noHtml5Validate
        >
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button kind="ghost" onClick={onDone} disabled={edit.isPending}>
              {t('btn_cancel')}
            </Button>
            <Button type="submit" icon={<I.check size={14} />} disabled={edit.isPending}>
              {edit.isPending ? t('btn_saving') : t('btn_save')}
            </Button>
          </div>
        </RjsfThemedForm>
      </div>
    </div>
  );
}
