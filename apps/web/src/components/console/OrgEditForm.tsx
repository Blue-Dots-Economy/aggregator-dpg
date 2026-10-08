'use client';

/**
 * Organisation details (user & org Phase 5): website, legal name and GST are
 * editable by the owner and the network admin; the name by the network admin
 * only; the Default org is read-only (P5-9, R8). Locations are shown, not
 * edited here (the address widget is the registration form's).
 */

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { Org } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Label } from '../ui/Label';
import { errorKey, sendConsole } from '../../lib/console-client';

/** Trimmed value, or null when blank (clears the field). */
const orNull = (v: string) => (v.trim() ? v.trim() : null);

export function OrgEditForm({
  org,
  editable,
  canRename,
}: {
  org: Org;
  editable: boolean;
  canRename: boolean;
}) {
  const t = useTranslations('console');
  const [current, setCurrent] = useState(org);
  const [name, setName] = useState(org.name);
  const [url, setUrl] = useState(org.url ?? '');
  const [legalName, setLegalName] = useState(org.legal_name ?? '');
  const [gst, setGst] = useState(org.gst_number ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
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

  return (
    <Card className="p-4">
      <h2 className="font-display text-[16px] font-bold text-ink-900 mb-3">{t('org.details')}</h2>
      {!editable ? <p className="text-[13px] text-ink-600 mb-3">{t('org.read_only')}</p> : null}
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3 max-w-xl">
        <div className="flex flex-col gap-1">
          <Label htmlFor="org-name">{t('org.name')}</Label>
          <Input
            id="org-name"
            value={name}
            disabled={!editable || !canRename}
            onChange={(e) => setName(e.target.value)}
          />
          {editable && !canRename ? (
            <span className="text-[12px] text-ink-500">{t('org.name_admin_only')}</span>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="org-url">{t('org.url')}</Label>
          <Input
            id="org-url"
            type="url"
            value={url}
            disabled={!editable}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="org-legal">{t('org.legal_name')}</Label>
          <Input
            id="org-legal"
            value={legalName}
            disabled={!editable}
            onChange={(e) => setLegalName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="org-gst">{t('org.gst_number')}</Label>
          <Input
            id="org-gst"
            value={gst}
            disabled={!editable}
            onChange={(e) => setGst(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1 text-[13.5px]">
          <span className="bd-label">{t('org.locations')}</span>
          {addresses.length ? (
            <ul className="list-disc pl-5">
              {addresses.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          ) : (
            <span className="text-ink-600">{t('org.no_locations')}</span>
          )}
        </div>
        {editable ? (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy}>
              {t('org.save')}
            </Button>
            {message ? (
              <span role="status" className="text-[13px] text-ink-600">
                {message}
              </span>
            ) : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}
