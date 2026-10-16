'use client';

/**
 * Organisation details (user & org Phase 5): website, legal name and GST are
 * editable by the owner and the network admin; the name by the network admin
 * only; the Default org is read-only (P5-9, R8). Locations are shown, not
 * edited here (the address widget is the registration form's).
 */

import { useState, type SubmitEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { Org } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { I } from '../../icons';
import { ConsoleSection, DetailList } from './ConsoleUi';
import { Input } from '../ui/Input';
import { Label } from '../ui/Label';
import { errorKey, sendConsole } from '../../lib/console-client';

/** Trimmed value, or null when blank (clears the field). */
const orNull = (v: string) => (v.trim() ? v.trim() : null);

export function OrgEditForm({
  org,
  editable,
  canRename,
}: Readonly<{
  org: Org;
  editable: boolean;
  canRename: boolean;
}>) {
  const t = useTranslations('console');
  const [current, setCurrent] = useState(org);
  const [name, setName] = useState(org.name);
  const [url, setUrl] = useState(org.url ?? '');
  const [legalName, setLegalName] = useState(org.legal_name ?? '');
  const [gst, setGst] = useState(org.gst_number ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    if (canRename && name.trim() !== current.name) patch['name'] = name.trim();
    if (orNull(url) !== current.url) patch['url'] = orNull(url);
    if (orNull(legalName) !== current.legal_name) patch['legal_name'] = orNull(legalName);
    if (orNull(gst) !== current.gst_number) patch['gst_number'] = orNull(gst);
    if (Object.keys(patch).length === 0) {
      setMessage(t('org.saved'));
      return;
    }
    setBusy(true);
    const r = await sendConsole<Org>(`/api/console/org/metadata/${org.id}`, 'PATCH', patch);
    setBusy(false);
    if (r.ok) {
      setCurrent(r.data);
      setMessage(t('org.saved'));
    } else {
      setMessage(t(errorKey(r)));
    }
  }

  const addresses = current.locations
    .map((l) =>
      [l.address?.streetAddress, l.address?.addressLocality, l.address?.addressRegion]
        .filter(Boolean)
        .join(', '),
    )
    .filter(Boolean);

  if (!editable) {
    // Read-only (the Default org, the root): plain text, not disabled inputs.
    return (
      <ConsoleSection title={t('org.details')}>
        <p className="text-[13px] text-ink-500 mb-4">{t('org.read_only')}</p>
        <DetailList
          items={[
            { label: t('org.name'), value: current.name },
            { label: t('org.url'), value: current.url ?? '—' },
            { label: t('org.legal_name'), value: current.legal_name ?? '—' },
            { label: t('org.gst_number'), value: current.gst_number ?? '—' },
            {
              label: t('org.locations'),
              value: addresses.length ? addresses.join('; ') : t('org.no_locations'),
            },
          ]}
        />
      </ConsoleSection>
    );
  }

  return (
    <ConsoleSection title={t('org.details')}>
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-name">{t('org.name')}</Label>
            <Input
              id="org-name"
              value={name}
              disabled={!canRename}
              onChange={(e) => setName(e.target.value)}
            />
            {!canRename ? (
              <span className="text-[12px] text-ink-500">{t('org.name_admin_only')}</span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-url">{t('org.url')}</Label>
            <Input id="org-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
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
            <Input id="org-gst" value={gst} onChange={(e) => setGst(e.target.value)} />
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
