'use client';

/**
 * Autocomplete backed by an external reference dataset instead of a schema `enum`.
 *
 * A field opts in with the `x-reference-source` marker (e.g. `"colleges"`),
 * passed here as `ui:options.source`. The widget fetches
 * `<base>/<dataset>.json`, so large lists live outside the schema.
 *
 * The stored value is the option name, a plain string. If the dataset fails
 * to load, the field works as a plain text input.
 *
 * Matches the Signals-DPG widget, except the dataset id and base URL come from
 * the form runtime config and errors are rendered by `FieldTemplate`.
 *
 * @module apps/web/components/forms/custom-widgets/ReferenceAutocompleteWidget
 */

import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { useFormRuntimeConfig } from '@/lib/FormRuntimeConfigProvider';
import { useSuggestionKeyboard } from './use-suggestion-keyboard';
import { withStableKeys } from '@/lib/list-keys';
import { useReferenceDataset } from '@/hooks/useReferenceDataset';
import { isRecord } from '../is-record';

interface ReferenceOption {
  name: string;
  district?: string;
  state?: string;
}

/** Option fields the marker's `subtitle` may reference. */
const SUBTITLE_FIELDS = ['district', 'state'] as const;
type SubtitleField = (typeof SUBTITLE_FIELDS)[number];
const DEFAULT_SUBTITLE: SubtitleField[] = ['district'];

function isSubtitleField(value: unknown): value is SubtitleField {
  return SUBTITLE_FIELDS.some((field) => field === value);
}

/** Maximum number of matches shown. */
const MAX_SUGGESTIONS = 50;
/** Shortest query that shows matches. */
const MIN_QUERY_LENGTH = 2;
const BLUR_CLOSE_MS = 150;

/** Reads `field` off an unverified record, or `undefined` if it is not a string. */
function stringField(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads the list under `key` of an unverified node, keeping only its object entries.
 *
 * @param node - A dataset node, shape unverified.
 * @param key - The key that holds the child list.
 * @returns The child records, or `[]` when the node or list is missing.
 */
function childRecords(node: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(node)) return [];
  const list = node[key];
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

/**
 * Builds one option, leaving out empty `district`/`state` keys.
 */
function toOption(
  name: string,
  district: string | undefined,
  state: string | undefined,
): ReferenceOption {
  return {
    name,
    ...(district ? { district } : {}),
    ...(state ? { state } : {}),
  };
}

/** Reads the flat shape: `[{ name, district?, state? }, ...]`. */
function flattenFlat(raw: unknown[]): ReferenceOption[] {
  const out: ReferenceOption[] = [];
  for (const record of raw.filter(isRecord)) {
    const name = stringField(record, 'name');
    if (!name) continue;
    out.push(toOption(name, stringField(record, 'district'), stringField(record, 'state')));
  }
  return out;
}

/**
 * Flattens the hierarchical shape (the KA/UP institute lists):
 * `{ states: [{ name, districts: [{ name, organizations: [...] }] }] }`.
 *
 * An organization's own `district`/`state` takes precedence over its parent nodes.
 */
function flattenHierarchical(raw: unknown): ReferenceOption[] {
  const out: ReferenceOption[] = [];
  for (const state of childRecords(raw, 'states')) {
    for (const district of childRecords(state, 'districts')) {
      for (const org of childRecords(district, 'organizations')) {
        const name = stringField(org, 'name');
        if (!name) continue;
        out.push(
          toOption(
            name,
            stringField(org, 'district') ?? stringField(district, 'name'),
            stringField(org, 'state') ?? stringField(state, 'name'),
          ),
        );
      }
    }
  }
  return out;
}

/**
 * Normalises either supported dataset shape into a flat option list.
 *
 * @param raw - Parsed dataset JSON, shape unverified.
 * @returns Flat options; entries without a string `name` are dropped.
 */
export function flattenReferenceDataset(raw: unknown): ReferenceOption[] {
  return Array.isArray(raw) ? flattenFlat(raw) : flattenHierarchical(raw);
}

/**
 * Resolves an `x-reference-source` value to a concrete dataset file id.
 *
 * `colleges` maps to `colleges-<COLLEGE_DATASET>` (e.g. `ka`, `up`). Any other
 * source id is used as-is.
 *
 * @param source - The marker's source id.
 * @param collegeDataset - Region code from the form runtime config.
 * @returns The dataset file id, without the `.json` extension.
 */
export function resolveDatasetId(source: string, collegeDataset: string): string {
  return source === 'colleges' ? `colleges-${collegeDataset}` : source;
}

/** Identifies an option by the fields it shows. */
function optionKey(option: ReferenceOption): string {
  return `${option.name}|${option.district ?? ''}|${option.state ?? ''}`;
}

export function ReferenceAutocompleteWidget({
  id,
  value,
  disabled,
  readonly,
  onChange,
  placeholder,
  options,
}: Readonly<WidgetProps>) {
  const source = typeof options.source === 'string' ? options.source : undefined;
  const subtitleOption: unknown = options.subtitleFields;
  // Unknown names are dropped. An explicit list, even `[]`, replaces the default.
  const subtitleFields: SubtitleField[] = Array.isArray(subtitleOption)
    ? subtitleOption.filter(isSubtitleField)
    : DEFAULT_SUBTITLE;

  const { collegeDataset, referenceBaseUrl } = useFormRuntimeConfig();
  // On a failed load the list is empty and the field works as plain text input.
  const dataset = useReferenceDataset(
    source ? resolveDatasetId(source, collegeDataset) : null,
    referenceBaseUrl,
    flattenReferenceDataset,
  );

  const valueText = typeof value === 'string' ? value : '';
  const [text, setText] = React.useState(valueText);
  // Take a new value from RJSF (e.g. a prefill) during render. The input keeps
  // its own text so typing is not held up by the form's update.
  const [syncedValue, setSyncedValue] = React.useState(valueText);
  if (valueText !== syncedValue) {
    setSyncedValue(valueText);
    setText(valueText);
  }
  const [open, setOpen] = React.useState(false);
  const blurRef = React.useRef<number | undefined>(undefined);

  React.useEffect(() => () => window.clearTimeout(blurRef.current), []);

  const suggestions = React.useMemo(() => {
    const q = text.trim().toLowerCase();
    if (q.length < MIN_QUERY_LENGTH) return [];
    return dataset.filter((o) => o.name.toLowerCase().includes(q)).slice(0, MAX_SUGGESTIONS);
  }, [text, dataset]);

  function handleInput(next: string) {
    setText(next);
    onChange(next === '' ? undefined : next);
    setOpen(next.trim().length >= MIN_QUERY_LENGTH);
  }

  function choose(option: ReferenceOption) {
    window.clearTimeout(blurRef.current);
    setText(option.name);
    onChange(option.name);
    setOpen(false);
  }

  /**
   * Builds the line under an option's name from `subtitleFields` (default: district).
   */
  function subtitle(option: ReferenceOption): string | null {
    const parts = subtitleFields
      .map((f) => option[f])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  const { activeIndex, setActiveIndex, optionId, activeDescendantId, listboxId, onKeyDown } =
    useSuggestionKeyboard({
      items: suggestions,
      open,
      onOpen: () => setOpen(true),
      onClose: () => setOpen(false),
      onSelect: (index) => {
        const option = suggestions[index];
        if (option) choose(option);
      },
      idPrefix: id,
    });

  return (
    <div className="relative">
      <Input
        id={id}
        value={text}
        disabled={Boolean(disabled || readonly)}
        autoComplete="off"
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendantId}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(suggestions.length > 0)}
        onBlur={() => {
          blurRef.current = window.setTimeout(() => setOpen(false), BLUR_CLOSE_MS);
        }}
      />
      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-[320px] w-full overflow-y-auto rounded-[10px] border border-(--bd-border) bg-(--bd-card) p-1 shadow-lg"
        >
          {withStableKeys(suggestions, optionKey).map(({ item: o, key }, i) => {
            const sub = subtitle(o);
            return (
              <li
                key={key}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                className={cn(
                  'cursor-pointer rounded-[8px] px-2 py-2 text-[14px] transition-colors',
                  i === activeIndex
                    ? 'bg-(--bd-primary-50) text-(--bd-primary-600)'
                    : 'hover:bg-(--bd-primary-50)',
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span className="block">{o.name}</span>
                {sub && <span className="block text-[12px] text-(--bd-fg-muted)">{sub}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
