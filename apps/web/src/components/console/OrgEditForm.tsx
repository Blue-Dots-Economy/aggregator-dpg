'use client';

/**
 * Organisation details form. Website, legal name, and GST are editable by the
 * owner and the network admin; the name and the "known as" value by the
 * network admin only. The "known as" choices are the values allowed at the
 * org's depth; changing the value never moves the org. The Default org is
 * read-only. Locations are shown but not edited here.
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
import type { KnownAsChoice } from '../../lib/console-org-options';

/** Trimmed value, or null when blank (clears the field). */
const orNull = (v: string) => (v.trim() ? v.trim() : null);

/** The "known as" name, or the key when it is not configured. */
const knownAsText = (o: Org) => o.known_as_name ?? o.known_as ?? '—';

export function OrgEditForm({
  org,
  editable,
  canRename,
  knownAsOptions = [],
}: Readonly<{
  org: Org;
  editable: boolean;
  canRename: boolean;
  /** The values allowed at the org's depth; empty shows the current value as text. */
  knownAsOptions?: readonly KnownAsChoice[];
}>) {
  const t = useTranslations('console');
  const [current, setCurrent] = useState(org);
  const [name, setName] = useState(org.name);
  const [url, setUrl] = useState(org.url ?? '');
  const [legalName, setLegalName] = useState(org.legal_name ?? '');
  const [gst, setGst] = useState(org.gst_number ?? '');
  const [knownAs, setKnownAs] = useState(org.known_as ?? '');
  const canChooseKnownAs = canRename && knownAsOptions.length > 0;
  const currentAllowed = knownAsOptions.some((o) => o.key === current.known_as);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    if (canRename && name.trim() !== current.name) patch['name'] = name.trim();
    if (orNull(url) !== current.url) patch['url'] = orNull(url);
    if (orNull(legalName) !== current.legal_name) patch['legal_name'] = orNull(legalName);
    if (orNull(gst) !== current.gst_number) patch['gst_number'] = orNull(gst);
    if (canChooseKnownAs && knownAs !== current.known_as) patch['known_as'] = knownAs;
    if (Object.keys(patch).length === 0) {
      setMessage(t('org.saved'));
      return;
    }
    setBusy(true);
    const r = await sendConsole<Org>(`/api/console/org/metadata/${org.id}`, 'PATCH', patch);
    setBusy(false);
    if (r.ok) {
      setCurrent(r.data);
      setKnownAs(r.data.known_as ?? '');
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
    // Read-only (the Default org, the root, an org below the viewer's own):
    // plain text, not disabled inputs.
    return (
      <ConsoleSection title={t('org.details')}>
        {current.is_default ? (
          <p className="text-[13px] text-ink-500 mb-4">{t('org.read_only')}</p>
        ) : null}
        <DetailList
          items={[
            { label: t('org.name'), value: current.name },
            ...(current.known_as === null
              ? []
              : [{ label: t('org.known_as'), value: knownAsText(current) }]),
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
            <Label htmlFor="org-known-as">{t('org.known_as')}</Label>
            {canChooseKnownAs ? (
              <>
                <select
                  id="org-known-as"
                  className="bd-input"
                  value={knownAs}
                  onChange={(e) => {
                    setKnownAs(e.target.value);
                    setMessage(null);
                  }}
                >
                  {currentAllowed ? null : (
                    <option value={current.known_as ?? ''}>{knownAsText(current)}</option>
                  )}
                  {knownAsOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.name}
                    </option>
                  ))}
                </select>
                {currentAllowed ? null : (
                  <span className="text-[12px] text-ink-500">{t('org.known_as_not_allowed')}</span>
                )}
              </>
            ) : (
              <>
                <Input id="org-known-as" value={knownAsText(current)} disabled readOnly />
                {canRename ? null : (
                  <span className="text-[12px] text-ink-500">{t('org.known_as_admin_only')}</span>
                )}
              </>
            )}
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
