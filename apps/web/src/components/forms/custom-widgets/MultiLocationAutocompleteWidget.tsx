'use client';

/**
 * Address autocomplete for an array `location`-marked schema field, one row per place.
 *
 * Used by up-gzb's `service_provider` profile (`serviceAreas`). Matches the
 * Signals-DPG widget, except the form context is read from
 * `registry.formContext` and errors are rendered by `FieldTemplate`.
 *
 * @module apps/web/components/forms/custom-widgets/MultiLocationAutocompleteWidget
 */

import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { getGeoProvider } from '@/lib/geo/provider';
import { useFormRuntimeConfig } from '@/lib/FormRuntimeConfigProvider';
import { useSuggestionKeyboard } from './use-suggestion-keyboard';
import { geoSuggestionKey } from './geo-suggestion-key';
import { withStableKeys } from '@/lib/list-keys';
import type { GeoSuggestion } from '@/lib/geo/types';
import { isRecord } from '../is-record';

export interface ResolvedCoord {
  lat: number;
  lng: number;
  label?: string;
}

export interface MultiLocationFormContext {
  onLocationsResolved?: (coords: ResolvedCoord[]) => void;
}

/**
 * Tells whether the form context has the shape this widget reads.
 *
 * Only the callback's presence can be checked at runtime, not its signature.
 */
function isMultiLocationFormContext(value: unknown): value is MultiLocationFormContext {
  return (
    isRecord(value) &&
    (value.onLocationsResolved === undefined || typeof value.onLocationsResolved === 'function')
  );
}

const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 300;
const BLUR_CLOSE_MS = 150;

interface LocationRow {
  id: string;
  name: string;
  coord: ResolvedCoord | null;
}

interface RowSearchState {
  suggestions: GeoSuggestion[];
  open: boolean;
}

/**
 * Per-row debounce, abort, and blur handles. Kept in a ref since they do not affect rendering.
 */
interface RowRefs {
  debounce: number | undefined;
  abort: AbortController | null;
  blur: number | undefined;
}

let rowIdCounter = 0;
function makeRow(name = ''): LocationRow {
  rowIdCounter += 1;
  return { id: `r${rowIdCounter}`, name, coord: null };
}

/** Builds rows for a value; always returns at least one row. */
function rowsFromValue(value: string[]): LocationRow[] {
  return value.length === 0 ? [makeRow()] : value.map((name) => makeRow(name));
}

/** Tells whether the rows' non-blank names equal the non-blank values, in order. */
function sameNames(rows: LocationRow[], value: string[]): boolean {
  const rowNames = rows.map((r) => r.name).filter(Boolean);
  const valueNames = value.filter(Boolean);
  return rowNames.length === valueNames.length && rowNames.every((n, i) => n === valueNames[i]);
}

interface RowComboboxProps {
  id: string;
  value: string;
  disabled: boolean;
  placeholder: string;
  suggestions: GeoSuggestion[];
  open: boolean;
  onInput: (next: string) => void;
  onOpenChange: (open: boolean) => void;
  onBlurClose: () => void;
  onChoose: (suggestion: GeoSuggestion) => void;
}

/**
 * One row's text input and its suggestion list.
 *
 * A separate component so each row has its own `useSuggestionKeyboard` state.
 */
function RowCombobox({
  id,
  value,
  disabled,
  placeholder,
  suggestions,
  open,
  onInput,
  onOpenChange,
  onBlurClose,
  onChoose,
}: Readonly<RowComboboxProps>) {
  const { activeIndex, setActiveIndex, optionId, activeDescendantId, listboxId, onKeyDown } =
    useSuggestionKeyboard({
      items: suggestions,
      open,
      onOpen: () => onOpenChange(true),
      onClose: () => onOpenChange(false),
      onSelect: (index) => {
        const suggestion = suggestions[index];
        if (suggestion) onChoose(suggestion);
      },
      idPrefix: id,
    });

  return (
    <div className="relative flex-1">
      <Input
        id={id}
        value={value}
        disabled={disabled}
        autoComplete="off"
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendantId}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => onOpenChange(suggestions.length > 0)}
        onBlur={onBlurClose}
      />
      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-[280px] w-full overflow-y-auto rounded-[10px] border border-(--bd-border) bg-(--bd-card) p-1 shadow-lg"
        >
          {withStableKeys(suggestions, geoSuggestionKey).map(({ item: s, key }, si) => (
            <li
              key={key}
              id={optionId(si)}
              role="option"
              aria-selected={si === activeIndex}
              className={cn(
                'cursor-pointer rounded-[8px] px-2 py-2 text-[14px] transition-colors',
                si === activeIndex
                  ? 'bg-(--bd-primary-50) text-(--bd-primary-600)'
                  : 'hover:bg-(--bd-primary-50)',
              )}
              // onMouseDown runs before the input's blur; preventDefault keeps focus.
              onMouseDown={(e) => {
                e.preventDefault();
                onChoose(s);
              }}
              onMouseEnter={() => setActiveIndex(si)}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MultiLocationAutocompleteWidget({
  id,
  value,
  disabled,
  readonly,
  onChange,
  schema,
  registry,
  options,
}: Readonly<WidgetProps>) {
  const t = useTranslations('form');
  const formContext: unknown = registry?.formContext;
  const ctx: MultiLocationFormContext = isMultiLocationFormContext(formContext) ? formContext : {};
  const isPrimary = options.isPrimaryLocation === true;

  // RJSF passes `undefined` on a fresh form.
  const incoming = React.useMemo<string[]>(
    () => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []),
    [value],
  );

  const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;

  const [rows, setRows] = React.useState<LocationRow[]>(() => rowsFromValue(incoming));
  // Search state per row, kept separate from `rows` but always the same length.
  const [searches, setSearches] = React.useState<RowSearchState[]>(() =>
    rows.map(() => ({ suggestions: [], open: false })),
  );
  const refsArray = React.useRef<RowRefs[]>([]);

  const config = useFormRuntimeConfig();
  const provider = React.useMemo(
    () =>
      getGeoProvider({
        ...(config.googleMapsApiKey ? { googleMapsApiKey: config.googleMapsApiKey } : {}),
        ...(config.photonUrl ? { photonUrl: config.photonUrl } : {}),
        ...(config.geoCountry ? { country: config.geoCountry } : {}),
      }),
    [config.googleMapsApiKey, config.photonUrl, config.geoCountry],
  );

  function ensureRefs(count: number) {
    while (refsArray.current.length < count) {
      refsArray.current.push({ debounce: undefined, abort: null, blur: undefined });
    }
  }
  ensureRefs(rows.length);

  // Take a new value from RJSF during render. The rows are rebuilt only when
  // their names differ from it, so blank rows and picked coordinates are kept.
  // A rebuild also clears every row's search state.
  const [syncedIncoming, setSyncedIncoming] = React.useState(incoming);
  const [rebuildCount, setRebuildCount] = React.useState(0);
  if (incoming !== syncedIncoming) {
    setSyncedIncoming(incoming);
    if (!sameNames(rows, incoming)) {
      const rebuilt = rowsFromValue(incoming);
      setRows(rebuilt);
      setSearches(rebuilt.map(() => ({ suggestions: [], open: false })));
      setRebuildCount((count) => count + 1);
    }
  }

  // After a rebuild, cancel every row's pending debounce, blur close and
  // in-flight search, so no earlier result lands on a new row. A layout effect
  // runs before any timer can fire.
  React.useLayoutEffect(() => {
    if (rebuildCount === 0) return;
    for (const ref of refsArray.current) {
      window.clearTimeout(ref.debounce);
      window.clearTimeout(ref.blur);
      ref.abort?.abort();
    }
  }, [rebuildCount]);

  React.useEffect(() => {
    ensureRefs(rows.length);
    setSearches((prev) => {
      if (prev.length === rows.length) return prev;
      if (prev.length < rows.length) {
        return [
          ...prev,
          ...Array.from({ length: rows.length - prev.length }, () => ({
            suggestions: [],
            open: false,
          })),
        ];
      }
      // Fewer rows: cancel pending work for the removed ones.
      for (let i = rows.length; i < prev.length; i += 1) {
        const ref = refsArray.current[i];
        if (ref) {
          window.clearTimeout(ref.debounce);
          window.clearTimeout(ref.blur);
          ref.abort?.abort();
        }
      }
      return prev.slice(0, rows.length);
    });
  }, [rows.length]);

  // Cancel everything pending on unmount.
  React.useEffect(
    () => () => {
      for (const ref of refsArray.current) {
        window.clearTimeout(ref.debounce);
        window.clearTimeout(ref.blur);
        ref.abort?.abort();
      }
    },
    [],
  );

  function emitChanges(nextRows: LocationRow[]) {
    const names = nextRows.map((r) => r.name).filter(Boolean);
    // `undefined`, not `[]`, so a required field with all rows blank fails validation.
    onChange(names.length > 0 ? names : undefined);
    if (isPrimary) {
      ctx.onLocationsResolved?.(
        nextRows
          .filter((r): r is LocationRow & { coord: ResolvedCoord } => r.coord !== null)
          .map((r) => r.coord),
      );
    }
  }

  function updateRow(index: number, patch: Partial<LocationRow>) {
    const next = rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
    setRows(next);
    emitChanges(next);
  }

  function updateSearch(index: number, patch: Partial<RowSearchState>) {
    setSearches((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function runSearch(index: number, query: string) {
    const ref = refsArray.current[index];
    if (!ref) return;
    window.clearTimeout(ref.debounce);
    ref.abort?.abort();

    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      updateSearch(index, { suggestions: [], open: false });
      return;
    }
    ref.debounce = window.setTimeout(() => {
      const controller = new AbortController();
      ref.abort = controller;
      void search(index, q, controller.signal);
    }, DEBOUNCE_MS);
  }

  /** Asks the geocoder for `q` and shows the results in row `index`, unless aborted. */
  async function search(index: number, q: string, signal: AbortSignal) {
    const results = await provider.suggest(q, signal);
    if (signal.aborted) return;
    updateSearch(index, { suggestions: results, open: results.length > 0 });
  }

  function handleInput(index: number, next: string) {
    // Typed text is not a resolved place, so clear the coordinate.
    updateRow(index, { name: next, coord: null });
    runSearch(index, next);
  }

  function choose(index: number, suggestion: GeoSuggestion) {
    const ref = refsArray.current[index];
    if (ref) {
      window.clearTimeout(ref.debounce);
      ref.abort?.abort();
    }
    updateRow(index, {
      name: suggestion.label,
      coord: { lat: suggestion.lat, lng: suggestion.lng, label: suggestion.label },
    });
    updateSearch(index, { suggestions: [], open: false });
  }

  function addRow() {
    if (maxItems !== undefined && rows.length >= maxItems) return;
    const next = [...rows, makeRow()];
    setRows(next);
    emitChanges(next);
  }

  function removeRow(index: number) {
    const ref = refsArray.current[index];
    if (ref) {
      window.clearTimeout(ref.debounce);
      window.clearTimeout(ref.blur);
      ref.abort?.abort();
    }
    refsArray.current.splice(index, 1);
    const next = rows.filter((_, i) => i !== index);
    setRows(next);
    emitChanges(next);
    setSearches((prev) => prev.filter((_, i) => i !== index));
  }

  const isDisabled = disabled === true || readonly === true;
  const atMax = maxItems !== undefined && rows.length >= maxItems;

  return (
    <div className="space-y-2">
      {rows.map((row, index) => {
        const search = searches[index] ?? { suggestions: [], open: false };
        return (
          <div key={row.id} className="flex items-start gap-2">
            <RowCombobox
              id={`${id}_${index}`}
              value={row.name}
              disabled={isDisabled}
              placeholder={t('location_search_placeholder')}
              suggestions={search.suggestions}
              open={search.open}
              onInput={(next) => handleInput(index, next)}
              onOpenChange={(next) => updateSearch(index, { open: next })}
              onBlurClose={() => {
                const ref = refsArray.current[index];
                if (ref) {
                  ref.blur = window.setTimeout(
                    () => updateSearch(index, { open: false }),
                    BLUR_CLOSE_MS,
                  );
                }
              }}
              onChoose={(suggestion) => choose(index, suggestion)}
            />
            <button
              type="button"
              aria-label={t('location_remove', { label: row.name || String(index + 1) })}
              title={t('location_remove', { label: row.name || String(index + 1) })}
              disabled={isDisabled}
              className="mt-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-(--bd-fg-muted) transition-colors hover:bg-(--bd-border-soft) hover:text-(--bd-fg) disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => removeRow(index)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        disabled={isDisabled || atMax}
        className="text-[13px] font-medium text-(--bd-primary-600) underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        onClick={addRow}
      >
        {t('location_add')}
      </button>
    </div>
  );
}
