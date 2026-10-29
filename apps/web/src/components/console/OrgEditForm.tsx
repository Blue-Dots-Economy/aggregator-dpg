'use client';

/**
 * Organisation details form. Website, legal name, and GST are editable by the
 * owner and the network admin; the name and the "known as" value by the
 * network admin only. A "known as" value sits at a level of the hierarchy, so
 * changing it also asks for a parent one level up. An org with child orgs
 * keeps its value and parent. The Default org is read-only. Locations are
 * shown but not edited here.
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

/** A selectable "known as" value and its level. */
export interface KnownAsChoice {
  key: string;
  label: string;
  level: number;
}

/** An org that can be a parent, with its level (0 for the network). */
export interface ParentChoice {
  id: string;
  name: string;
  level: number;
}

export function OrgEditForm({
  org,
  editable,
  canRename,
  knownAsOptions = [],
  parentOptions = [],
  hasChildren = false,
}: Readonly<{
  org: Org;
  editable: boolean;
  canRename: boolean;
  /** The configured values; empty shows the current value as text. */
  knownAsOptions?: readonly KnownAsChoice[];
  /** Orgs that can be a parent (the network included). */
  parentOptions?: readonly ParentChoice[];
  /** Whether child orgs sit under this one; its value and parent then stay. */
  hasChildren?: boolean;
}>) {
  const t = useTranslations('console');
  /** The "known as" label with its level, e.g. "District (level 2)"; the key alone when not configured. */
  const knownAsText = (o: Org) =>
    o.level === null
      ? (o.known_as ?? '—')
      : t('org.known_as_level', { label: o.known_as_label ?? o.known_as ?? '—', level: o.level });
  const [current, setCurrent] = useState(org);
  const [name, setName] = useState(org.name);
  const [url, setUrl] = useState(org.url ?? '');
  const [legalName, setLegalName] = useState(org.legal_name ?? '');
  const [gst, setGst] = useState(org.gst_number ?? '');
  const [knownAs, setKnownAs] = useState(org.known_as ?? '');
  const [parentId, setParentId] = useState('');
  const canPlace = canRename && knownAsOptions.length > 0 && !hasChildren;
  const placing = canPlace && knownAs !== current.known_as;
  const newLevel = knownAsOptions.find((o) => o.key === knownAs)?.level ?? null;
  const parentChoices =
    newLevel === null
      ? []
      : parentOptions.filter((p) => p.level === newLevel - 1 && p.id !== org.id);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    if (canRename && name.trim() !== current.name) patch['name'] = name.trim();
    if (orNull(url) !== current.url) patch['url'] = orNull(url);
    if (orNull(legalName) !== current.legal_name) patch['legal_name'] = orNull(legalName);
    if (orNull(gst) !== current.gst_number) patch['gst_number'] = orNull(gst);
    if (placing) {
      if (!parentId) {
        setMessage(t('org.parent_required'));
        return;
      }
      patch['known_as'] = knownAs;
      patch['parent_id'] = parentId;
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
      setKnownAs(r.data.known_as ?? '');
      setParentId('');
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
            {canPlace ? (
              <select
                id="org-known-as"
                className="bd-input"
                value={knownAs}
                onChange={(e) => {
                  setKnownAs(e.target.value);
                  setParentId('');
                  setMessage(null);
                }}
              >
                {knownAsOptions.some((o) => o.key === knownAs) ? null : (
                  <option value={knownAs}>{knownAsText(current)}</option>
                )}
                {knownAsOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {t('org.known_as_level', { label: o.label, level: o.level })}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <Input id="org-known-as" value={knownAsText(current)} disabled readOnly />
                {!canRename ? (
                  <span className="text-[12px] text-ink-500">{t('org.known_as_admin_only')}</span>
                ) : hasChildren ? (
                  <span className="text-[12px] text-ink-500">{t('org.known_as_has_children')}</span>
                ) : null}
              </>
            )}
          </div>
          {placing ? (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="org-parent">{t('org.parent')}</Label>
              <select
                id="org-parent"
                className="bd-input"
                value={parentId}
                aria-required
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">{t('org.parent_placeholder')}</option>
                {parentChoices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <span className="text-[12px] text-ink-500">
                {parentChoices.length > 0
                  ? t('org.parent_hint', { level: (newLevel ?? 1) - 1 })
                  : t('org.parent_none', { level: (newLevel ?? 1) - 1 })}
              </span>
            </div>
          ) : null}
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
          <Button type="submit" disabled={busy || (placing && !parentId)}>
            {t('org.save')}
          </Button>
          {message ? <output className="text-[13px] text-ink-600">{message}</output> : null}
        </div>
      </form>
    </ConsoleSection>
  );
}
