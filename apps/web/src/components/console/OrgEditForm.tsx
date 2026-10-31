'use client';

/**
 * Organisation details form. Two parts:
 *
 * - Fixed fields: name, legal name and description (inputs), locations (shown).
 * - Schema fields: whatever the deployment's org-registration schema lists
 *   (e.g. website, GST number, domains), drawn by RJSF. Fields marked
 *   `x-updatable` are editable; the others are shown read-only.
 *
 * Only the org's owner edits; anyone else (the network admin) sees every
 * detail read-only. The Default org and the root are read-only.
 */

import { useMemo, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { useTranslations } from 'next-intl';
import type Form from '@rjsf/core';
import type { ErrorSchema, RJSFSchema, UiSchema } from '@rjsf/utils';
import type { Org } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { I } from '../../icons';
import { ConsoleSection, DetailList } from './ConsoleUi';
import { Input } from '../ui/Input';
import { Label } from '../ui/Label';
import { RjsfThemedForm } from '../forms/RjsfThemed';
import { errorKey, sendConsole } from '../../lib/console-client';
import { consoleOrgSchema, gstinCustomValidate, orgFieldText } from '../../lib/org-schema';
import { readableFormErrors } from '../../lib/readable-form-errors';

/** Longest description the API accepts. */
const DESCRIPTION_MAX = 1000;

type JsonRecord = Record<string, unknown>;

/** Trimmed value, or null when blank (clears the field). */
const orNull = (v: string) => (v.trim() ? v.trim() : null);

/** Whether a schema value is empty (cleared). */
const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Whether two schema values are the same (order of a list counts). */
const sameValue = (a: unknown, b: unknown) =>
  (isEmpty(a) && isEmpty(b)) || JSON.stringify(a) === JSON.stringify(b);

/** The values of `fields` in `profile`. */
function pick(profile: JsonRecord, fields: readonly string[]): JsonRecord {
  return Object.fromEntries(fields.filter((f) => f in profile).map((f) => [f, profile[f]]));
}

export function OrgEditForm({
  org,
  editable,
  canEdit,
  orgSchema,
}: Readonly<{
  org: Org;
  /** False for the Default org and the root. */
  editable: boolean;
  /** The signed-in user owns this org. */
  canEdit: boolean;
  /** The deployment's org-registration schema (network domains applied); `null` if unavailable. */
  orgSchema: { schema: RJSFSchema; uiSchema: JsonRecord } | null;
}>) {
  const t = useTranslations('console');
  const editing = editable && canEdit;
  const view = useMemo(
    () => (orgSchema ? consoleOrgSchema(orgSchema.schema, orgSchema.uiSchema, editing) : null),
    [orgSchema, editing],
  );
  const fields = useMemo(() => Object.keys((view?.schema.properties ?? {}) as JsonRecord), [view]);
  const customValidate = useMemo(
    () => (view ? gstinCustomValidate(view.schema) : undefined),
    [view],
  );

  const [current, setCurrent] = useState(org);
  const [name, setName] = useState(org.name);
  const [legalName, setLegalName] = useState(org.legal_name ?? '');
  const [description, setDescription] = useState(org.description ?? '');
  const [profileData, setProfileData] = useState<JsonRecord>(() => pick(org.profile, fields));
  const [extraErrors, setExtraErrors] = useState<ErrorSchema | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const schemaForm = useRef<Form<JsonRecord>>(null);

  /** The schema fields the owner changed: new value, or `null` to clear. */
  function profileChanges(): JsonRecord {
    const changes: JsonRecord = {};
    for (const field of view?.updatable ?? []) {
      const next = profileData[field];
      if (sameValue(next, current.profile[field])) continue;
      changes[field] = isEmpty(next) ? null : next;
    }
    return changes;
  }

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setExtraErrors(undefined);
    // The schema section checks itself (patterns, choices, GSTIN check character).
    if (view && view.updatable.length > 0 && schemaForm.current?.validateForm() === false) {
      setMessage(t('org.fix_fields'));
      return;
    }
    const patch: JsonRecord = {};
    if (name.trim() !== current.name) patch['name'] = name.trim();
    if (orNull(legalName) !== current.legal_name) patch['legal_name'] = orNull(legalName);
    if (orNull(description) !== current.description) patch['description'] = orNull(description);
    const changes = profileChanges();
    if (Object.keys(changes).length > 0) patch['profile'] = changes;
    if (Object.keys(patch).length === 0) {
      setMessage(t('org.saved'));
      return;
    }
    setBusy(true);
    const r = await sendConsole<Org>(`/api/console/org/metadata/${org.id}`, 'PATCH', patch);
    setBusy(false);
    if (r.ok) {
      setCurrent(r.data);
      // The API tidies values (e.g. a GSTIN is stored upper-cased).
      setProfileData(pick(r.data.profile, fields));
      setMessage(t('org.saved'));
      return;
    }
    const serverErrors = r.error.fields?.['field_errors'];
    if (r.status === 400 && serverErrors && typeof serverErrors === 'object') {
      const mapped: JsonRecord = {};
      for (const [field, text] of Object.entries(serverErrors as JsonRecord)) {
        if (fields.includes(field)) mapped[field] = { __errors: [String(text)] };
      }
      if (Object.keys(mapped).length > 0) {
        setExtraErrors(mapped as ErrorSchema);
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

  if (!editing) {
    // Read-only (the Default org, the root, or not the owner): plain text, not disabled inputs.
    const props = (view?.schema.properties ?? {}) as Record<string, JsonRecord>;
    const ui = view?.uiSchema ?? {};
    const schemaItems = fields.map((field) => ({
      label: String(props[field]?.['title'] ?? field),
      value:
        orgFieldText(props[field] ?? {}, (ui[field] ?? {}) as JsonRecord, current.profile[field]) ??
        '—',
    }));
    const items: Array<{ label: string; value: ReactNode }> = [
      { label: t('org.name'), value: current.name },
      { label: t('org.legal_name'), value: current.legal_name ?? '—' },
      ...schemaItems,
      {
        label: t('org.description'),
        value: current.description ? (
          <span className="whitespace-pre-line">{current.description}</span>
        ) : (
          t('org.no_description')
        ),
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

  return (
    <ConsoleSection title={t('org.details')}>
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-name">{t('org.name')}</Label>
            <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-legal">{t('org.legal_name')}</Label>
            <Input
              id="org-legal"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
            />
          </div>
        </div>
        {view && fields.length > 0 ? (
          <RjsfThemedForm<JsonRecord>
            ref={schemaForm}
            tagName="div"
            schema={view.schema}
            uiSchema={
              {
                ...view.uiSchema,
                'ui:layout': 'grid',
                'ui:submitButtonOptions': { norender: true },
              } as unknown as UiSchema<JsonRecord>
            }
            formData={profileData}
            onChange={(ev) => {
              setProfileData((ev.formData ?? {}) as JsonRecord);
              setExtraErrors(undefined);
            }}
            transformErrors={(errors) => readableFormErrors(errors, view.schema)}
            {...(customValidate ? { customValidate } : {})}
            {...(extraErrors ? { extraErrors } : {})}
          />
        ) : null}
        <div className="flex flex-col gap-1.5">
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
