'use client';

/**
 * Organisation details form. Every field, the name included, is editable by
 * the org's owner only; anyone else (the network admin) sees the details
 * read-only. The Default org is read-only. Locations are shown but not edited
 * here.
 */

import { useState, type ReactNode, type SubmitEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { Org } from '@aggregator-dpg/shared-primitives/user-org';
import { isValidGstin, isValidWebsite } from '@aggregator-dpg/shared-primitives/org-details';
import { Button } from '../ui/Button';
import { I } from '../../icons';
import { ConsoleSection, DetailList } from './ConsoleUi';
import { Input } from '../ui/Input';
import { Label } from '../ui/Label';
import { MultiSelect } from '../ui/MultiSelect';
import { errorKey, sendConsole } from '../../lib/console-client';

/** Longest description the API accepts. */
const DESCRIPTION_MAX = 1000;

/** Trimmed value, or null when blank (clears the field). */
const orNull = (v: string) => (v.trim() ? v.trim() : null);

/** Fields whose errors the form shows under the input. */
type CheckedField = 'url' | 'gst_number' | 'domains';

/** Classes that mark an input whose value was refused. */
const INVALID_INPUT = 'border-rose-400 ring-4 ring-rose-100';

/** Whether two id lists hold the same ids, in any order. */
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

export function OrgEditForm({
  org,
  editable,
  canEdit,
  domains,
}: Readonly<{
  org: Org;
  /** False for the Default org and the root. */
  editable: boolean;
  /** The signed-in user owns this org. */
  canEdit: boolean;
  /** The network's domains, in configuration order. */
  domains: Array<{ id: string; label: string }>;
}>) {
  const t = useTranslations('console');
  const [current, setCurrent] = useState(org);
  const [name, setName] = useState(org.name);
  const [url, setUrl] = useState(org.url ?? '');
  const [legalName, setLegalName] = useState(org.legal_name ?? '');
  const [gst, setGst] = useState(org.gst_number ?? '');
  const [description, setDescription] = useState(org.description ?? '');
  const [orgDomains, setOrgDomains] = useState<string[]>(org.domains);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<CheckedField, string>>>({});
  const [busy, setBusy] = useState(false);

  /** Translated message for a refused field; the server's text for any other. */
  function fieldMessage(field: string, serverMessage: string): string {
    if (field === 'url') return t('org.invalid_url');
    if (field === 'gst_number') return t('org.invalid_gst');
    return serverMessage;
  }

  /** Drops a field's error once its value is edited. */
  function clearError(field: CheckedField) {
    setFieldErrors((errors) => {
      if (!errors[field]) return errors;
      const next = { ...errors };
      delete next[field];
      return next;
    });
  }

  /** Error state of one input: its message, and the props that mark it. */
  function errorOf(field: CheckedField) {
    const text = fieldErrors[field];
    return {
      text,
      inputProps: text
        ? {
            'aria-invalid': true,
            'aria-describedby': `org-${field}-error`,
            className: INVALID_INPUT,
          }
        : {},
      node: text ? (
        <span id={`org-${field}-error`} className="text-[12px] text-rose-600">
          {text}
        </span>
      ) : null,
    };
  }

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    if (name.trim() !== current.name) patch['name'] = name.trim();
    if (orNull(url) !== current.url) patch['url'] = orNull(url);
    if (orNull(legalName) !== current.legal_name) patch['legal_name'] = orNull(legalName);
    if (orNull(gst) !== current.gst_number) patch['gst_number'] = orNull(gst);
    if (orNull(description) !== current.description) patch['description'] = orNull(description);
    if (!sameIds(orgDomains, current.domains)) {
      // Sent in configuration order, so the stored list reads the same everywhere.
      patch['domains'] = domains.map((d) => d.id).filter((id) => orgDomains.includes(id));
    }
    // Only values being sent are checked, as the API does; a stored value is left alone.
    const errors: Partial<Record<CheckedField, string>> = {};
    if (typeof patch['url'] === 'string' && !isValidWebsite(patch['url'])) {
      errors.url = t('org.invalid_url');
    }
    if (typeof patch['gst_number'] === 'string' && !isValidGstin(patch['gst_number'])) {
      errors.gst_number = t('org.invalid_gst');
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setMessage(t('org.fix_fields'));
      return;
    }
    if (Object.keys(patch).length === 0) {
      setMessage(t('org.saved'));
      return;
    }
    setBusy(true);
    const r = await sendConsole<Org>(`/api/console/org/metadata/${org.id}`, 'PATCH', patch);
    setBusy(false);
    if (r.ok) {
      setCurrent(r.data);
      setOrgDomains(r.data.domains);
      // The API stores the GST number upper-cased.
      setGst(r.data.gst_number ?? '');
      setMessage(t('org.saved'));
      return;
    }
    const serverErrors = r.error.fields?.['field_errors'];
    if (r.status === 400 && serverErrors && typeof serverErrors === 'object') {
      const mapped: Partial<Record<CheckedField, string>> = {};
      for (const [field, text] of Object.entries(serverErrors as Record<string, unknown>)) {
        if (field === 'url' || field === 'gst_number' || field === 'domains') {
          mapped[field] = fieldMessage(field, String(text));
        }
      }
      if (Object.keys(mapped).length > 0) {
        setFieldErrors(mapped);
        setMessage(t('org.fix_fields'));
        return;
      }
    }
    setMessage(t(errorKey(r)));
  }

  const addresses = current.locations
    .map((l) =>
      [l.address?.streetAddress, l.address?.addressLocality, l.address?.addressRegion]
        .filter(Boolean)
        .join(', '),
    )
    .filter(Boolean);

  if (!editable || !canEdit) {
    // Read-only (the Default org, the root, or not the owner): plain text, not disabled inputs.
    const domainLabels = current.domains.map((id) => domains.find((d) => d.id === id)?.label ?? id);
    const items: Array<{ label: string; value: ReactNode }> = [
      { label: t('org.name'), value: current.name },
      { label: t('org.url'), value: current.url ?? '—' },
      { label: t('org.legal_name'), value: current.legal_name ?? '—' },
      { label: t('org.gst_number'), value: current.gst_number ?? '—' },
      {
        label: t('org.description'),
        value: current.description ? (
          <span className="whitespace-pre-line">{current.description}</span>
        ) : (
          t('org.no_description')
        ),
      },
      {
        label: t('org.domains'),
        value: domainLabels.length ? domainLabels.join(', ') : t('org.no_domains'),
      },
      {
        label: t('org.locations'),
        value: addresses.length ? addresses.join('; ') : t('org.no_locations'),
      },
    ];
    return (
      <ConsoleSection title={t('org.details')}>
        <p className="text-[13px] text-ink-500 mb-4">
          {editable ? t('org.details_owner_only') : t('org.read_only')}
        </p>
        <DetailList items={items} />
      </ConsoleSection>
    );
  }

  const urlError = errorOf('url');
  const gstError = errorOf('gst_number');
  const domainsError = errorOf('domains');

  return (
    <ConsoleSection title={t('org.details')}>
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-name">{t('org.name')}</Label>
            <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-url">{t('org.url')}</Label>
            <Input
              id="org-url"
              inputMode="url"
              autoComplete="url"
              placeholder={t('org.url_placeholder')}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                clearError('url');
              }}
              {...urlError.inputProps}
            />
            {urlError.node}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-legal">{t('org.legal_name')}</Label>
            <Input
              id="org-legal"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-gst">{t('org.gst_number')}</Label>
            <Input
              id="org-gst"
              autoCapitalize="characters"
              maxLength={15}
              placeholder={t('org.gst_placeholder')}
              value={gst}
              onChange={(e) => {
                setGst(e.target.value);
                clearError('gst_number');
              }}
              {...gstError.inputProps}
            />
            {gstError.node}
          </div>
          {domains.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="org-domains">{t('org.domains')}</Label>
              <MultiSelect
                id="org-domains"
                options={domains.map((d) => ({ value: d.id, label: d.label }))}
                value={orgDomains}
                onChange={(next) => {
                  setOrgDomains(next);
                  clearError('domains');
                }}
                placeholder={t('org.domains_placeholder')}
                {...(domainsError.text ? { className: INVALID_INPUT } : {})}
              />
              {domainsError.node}
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="org-description">{t('org.description')}</Label>
            <textarea
              id="org-description"
              className="bd-input min-h-[110px] resize-y"
              maxLength={DESCRIPTION_MAX}
              placeholder={t('org.description_placeholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="flex justify-between gap-3 text-[12px] text-ink-500">
              <span>{t('org.description_hint')}</span>
              <span aria-live="polite">
                {description.length}/{DESCRIPTION_MAX}
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 text-[13.5px]">
          <span className="bd-label">{t('org.locations')}</span>
          {addresses.length ? (
            <ul className="flex flex-col gap-1">
              {addresses.map((a, i) => (
                <li key={`${a}-${i}`} className="flex items-start gap-2 text-ink-700">
                  <I.globe size={14} className="mt-0.5 shrink-0 text-ink-400" />
                  {a}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-ink-500">{t('org.no_locations')}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            {t('org.save')}
          </Button>
          {message ? <output className="text-[13px] text-ink-600">{message}</output> : null}
        </div>
      </form>
    </ConsoleSection>
  );
}
