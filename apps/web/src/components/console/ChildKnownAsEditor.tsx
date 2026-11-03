'use client';

/**
 * Editor for the "known as" values an organisation defines for the
 * organisations directly under it.
 *
 * Each row has a name and a "default" choice. The API makes each new value's
 * key from its name; a saved value sends its key back, so a rename keeps the
 * organisations that use it linked. Removing a value resets the organisations
 * that use it to the default value, else to "Aggregator".
 */

import { useState, type SubmitEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import {
  KNOWN_AS_MAX_VALUES,
  KNOWN_AS_NAME_MAX,
  type ChildKnownAs,
  type KnownAsEntryRequest,
} from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { I } from '../../icons';
import { errorKey, setOrgChildKnownAs } from '../../lib/console-client';

/** One row of the editor. `key` is set for a saved value only. */
interface Row {
  /** Local id for React keys and the default choice. */
  id: number;
  key?: string;
  name: string;
}

let nextRowId = 0;

/** The rows and the default row's id for a saved list. */
function rowsOf(values: ChildKnownAs): { rows: Row[]; defaultId: number | null } {
  let defaultId: number | null = null;
  const rows = values.map((v) => {
    const row: Row = { id: ++nextRowId, key: v.key, name: v.name };
    if (v.default) defaultId = row.id;
    return row;
  });
  return { rows, defaultId };
}

/** The request body entries for the rows. */
function toRequest(rows: readonly Row[], defaultId: number | null): KnownAsEntryRequest[] {
  return rows.map((r) => ({
    ...(r.key ? { key: r.key } : {}),
    name: r.name.trim(),
    ...(r.id === defaultId ? { default: true as const } : {}),
  }));
}

/** The request body entries that would save `values` unchanged. */
function requestOfSaved(values: ChildKnownAs): KnownAsEntryRequest[] {
  return values.map((v) => ({
    key: v.key,
    name: v.name,
    ...(v.default ? { default: true as const } : {}),
  }));
}

/** Whether two saved lists have the same keys, names and default, in order. */
function sameList(a: ChildKnownAs, b: ChildKnownAs): boolean {
  return JSON.stringify(requestOfSaved(a)) === JSON.stringify(requestOfSaved(b));
}

/**
 * Renders the editor for an organisation's `child_known_as` list.
 *
 * @param orgId - The organisation that defines the list (the root for the network).
 * @param values - The saved list.
 */
export function ChildKnownAsEditor({
  orgId,
  values,
}: Readonly<{
  orgId: string;
  values: ChildKnownAs;
}>) {
  const t = useTranslations('console');
  const router = useRouter();
  const [saved, setSaved] = useState(values);
  const [state, setState] = useState(() => rowsOf(values));
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { rows, defaultId } = state;

  // A list from the page with different keys, names or default replaces the
  // editor's copy. The same list in a new object keeps unsaved edits.
  const [seen, setSeen] = useState(values);
  if (values !== seen && !sameList(values, seen)) {
    setSeen(values);
    setSaved(values);
    setState(rowsOf(values));
  }

  const dirty =
    JSON.stringify(toRequest(rows, defaultId)) !== JSON.stringify(requestOfSaved(saved));

  function update(next: Partial<typeof state>) {
    setState((s) => ({ ...s, ...next }));
    setMessage(null);
  }

  function rename(id: number, name: string) {
    update({ rows: rows.map((r) => (r.id === id ? { ...r, name } : r)) });
  }

  function remove(id: number) {
    update({
      rows: rows.filter((r) => r.id !== id),
      defaultId: defaultId === id ? null : defaultId,
    });
  }

  function add() {
    if (rows.length >= KNOWN_AS_MAX_VALUES) return;
    update({ rows: [...rows, { id: ++nextRowId, name: '' }] });
  }

  /** The message key of the first problem in the rows, or null. */
  function problem(): string | null {
    const names = rows.map((r) => r.name.trim().toLowerCase());
    if (names.some((n) => n === '')) return 'org.child_known_as_name_required';
    if (new Set(names).size !== names.length) return 'org.child_known_as_name_repeated';
    return null;
  }

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const bad = problem();
    if (bad) {
      setMessage(t(bad));
      return;
    }
    setBusy(true);
    const r = await setOrgChildKnownAs(orgId, toRequest(rows, defaultId));
    setBusy(false);
    if (r.ok) {
      setSaved(r.data.child_known_as);
      setState(rowsOf(r.data.child_known_as));
      setMessage(t('org.saved'));
      router.refresh();
      return;
    }
    setMessage(t(errorKey(r)));
  }

  return (
    <form noValidate onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
      <p className="text-[13px] text-ink-500">{t('org.child_known_as_hint')}</p>
      {rows.length === 0 ? (
        <p className="rounded-[12px] border border-dashed border-(--bd-border) px-3.5 py-3 text-[13px] text-ink-500">
          {t('org.child_known_as_empty')}
        </p>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{t('org.child_known_as_title')}</legend>
          {rows.map((r, i) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center gap-3 rounded-[12px] border border-(--bd-border) px-3.5 py-2.5"
            >
              <Input
                aria-label={t('org.child_known_as_name', { n: i + 1 })}
                className="min-w-[12rem] flex-1"
                value={r.name}
                maxLength={KNOWN_AS_NAME_MAX}
                onChange={(e) => rename(r.id, e.target.value)}
              />
              <label className="inline-flex items-center gap-1.5 text-[13px] text-ink-700">
                <input
                  type="radio"
                  name={`child-known-as-default-${orgId}`}
                  checked={defaultId === r.id}
                  onChange={() => update({ defaultId: r.id })}
                />
                {t('org.child_known_as_default')}
              </label>
              <Button
                kind="ghost"
                aria-label={t('org.child_known_as_remove', { name: r.name.trim() || i + 1 })}
                icon={<Trash2 size={14} aria-hidden="true" />}
                onClick={() => remove(r.id)}
              />
            </div>
          ))}
          <label className="inline-flex items-center gap-1.5 px-3.5 text-[13px] text-ink-700">
            <input
              type="radio"
              name={`child-known-as-default-${orgId}`}
              checked={defaultId === null}
              onChange={() => update({ defaultId: null })}
            />
            {t('org.child_known_as_no_default')}
          </label>
        </fieldset>
      )}
      <ul className="flex list-disc flex-col gap-1 pl-5 text-[12px] text-ink-500">
        <li>{t('org.child_known_as_default_note')}</li>
        <li>{t('org.child_known_as_remove_note')}</li>
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          kind="soft"
          icon={<I.plus size={14} aria-hidden="true" />}
          disabled={rows.length >= KNOWN_AS_MAX_VALUES}
          onClick={add}
        >
          {t('org.child_known_as_add')}
        </Button>
        {rows.length >= KNOWN_AS_MAX_VALUES ? (
          <span className="text-[12px] text-ink-500">
            {t('org.child_known_as_max', { max: KNOWN_AS_MAX_VALUES })}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !dirty}>
          {t('org.save')}
        </Button>
        {message ? <output className="text-[13px] text-ink-600">{message}</output> : null}
      </div>
    </form>
  );
}
