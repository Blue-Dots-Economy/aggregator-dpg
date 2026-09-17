'use client';

/**
 * Autocomplete backed by an EXTERNAL reference dataset rather than an inline
 * JSON-Schema `enum`.
 *
 * A field opts in with the custom `x-reference-source` marker in network.json
 * (e.g. `"colleges"`), which the uiSchema builder maps to this widget with
 * `ui:options.source`. The widget fetches `<base>/<dataset>.json` — so a list
 * far too large for network.json (the college/institute lists run to hundreds of
 * thousands of entries) lives outside the schema and can be updated without a
 * schema change.
 *
 * The stored value is the plain option NAME, so the field stays a simple
 * `type: "string"` and any existing free-text value keeps working. A failed
 * dataset load degrades to a plain text input rather than blocking the field.
 *
 * Ported from Signals-DPG
 * `apps/ui/src/components/forms/custom-widgets/reference-autocomplete-widget.tsx`.
 * The dataset id and base URL come from the form runtime config instead of
 * `import.meta.env`, and errors are left to `FieldTemplate`.
 *
 * @module apps/web/components/forms/custom-widgets/ReferenceAutocompleteWidget
 */

import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { Input } from '../../ui/Input';
import { cn } from '../../../lib/cn';
import { useFormRuntimeConfig } from '../../../lib/FormRuntimeConfigProvider';
import { useSuggestionKeyboard } from './use-suggestion-keyboard';

interface ReferenceOption {
  name: string;
  district?: string;
  state?: string;
}

/** Option fields the marker's `subtitle` may reference. */
const SUBTITLE_FIELDS = ['district', 'state'] as const;
type SubtitleField = (typeof SUBTITLE_FIELDS)[number];
const DEFAULT_SUBTITLE: SubtitleField[] = ['district'];

type HierarchicalDataset = {
  states?: Array<{
    name?: string;
    districts?: Array<{
      name?: string;
      organizations?: Array<Record<string, unknown>>;
    }>;
  }>;
};

/** Cap on rendered matches — a two-character query can match tens of thousands. */
const MAX_SUGGESTIONS = 50;
/** Below this, a query matches too much of the dataset to be worth listing. */
const MIN_QUERY_LENGTH = 2;
const BLUR_CLOSE_MS = 150;

/**
 * Module-level so switching fields or re-mounting the form doesn't refetch the
 * (large) dataset. Holds the in-flight promise, keyed by resolved dataset id.
 */
const datasetCache = new Map<string, Promise<ReferenceOption[]>>();

/**
 * Normalises either supported dataset shape into a flat option list:
 * hierarchical (`{ states: [{ districts: [{ organizations: [...] }] }] }`, the
 * KA/UP institute lists) or already-flat (`[{ name, district?, state? }]`).
 *
 * @param raw - Parsed dataset JSON, shape unverified.
 * @returns Flat options; entries without a string `name` are dropped.
 */
export function flattenReferenceDataset(raw: unknown): ReferenceOption[] {
  if (Array.isArray(raw)) {
    const flat: ReferenceOption[] = [];
    for (const entry of raw) {
      const o = entry as Record<string, unknown>;
      if (typeof o.name !== 'string') continue;
      flat.push({
        name: o.name,
        ...(typeof o.district === 'string' ? { district: o.district } : {}),
        ...(typeof o.state === 'string' ? { state: o.state } : {}),
      });
    }
    return flat;
  }

  const ds = raw as HierarchicalDataset;
  const out: ReferenceOption[] = [];
  for (const state of ds.states ?? []) {
    for (const district of state.districts ?? []) {
      for (const org of district.organizations ?? []) {
        const name = typeof org.name === 'string' ? org.name : undefined;
        if (!name) continue;
        const resolvedDistrict = typeof org.district === 'string' ? org.district : district.name;
        const resolvedState = typeof org.state === 'string' ? org.state : state.name;
        out.push({
          name,
          ...(resolvedDistrict ? { district: resolvedDistrict } : {}),
          ...(resolvedState ? { state: resolvedState } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Resolves an `x-reference-source` value to a concrete dataset file id.
 *
 * `colleges` is region-scoped: the state is chosen per deployment via
 * `COLLEGE_DATASET` (`ka` | `up`), so one build serves any state with no schema
 * change. Any other source id is used verbatim.
 *
 * @param source - The marker's source id.
 * @param collegeDataset - Region code from the form runtime config.
 * @returns The dataset file id, without the `.json` extension.
 */
export function resolveDatasetId(source: string, collegeDataset: string): string {
  return source === 'colleges' ? `colleges-${collegeDataset}` : source;
}

/**
 * Builds the URL a dataset is fetched from.
 *
 * Defaults to the app's own `/reference/`, which is where a deployment mounts
 * its ConfigMap over the copies baked into the image. An absolute
 * `referenceBaseUrl` is used as-is; a relative one resolves against the app
 * origin. A remote host must send permissive CORS headers — the browser fetches
 * it directly.
 *
 * @param id - Resolved dataset file id.
 * @param referenceBaseUrl - Optional base URL override.
 * @returns An absolute URL to the dataset JSON.
 */
function referenceUrl(id: string, referenceBaseUrl: string | undefined): string {
  const raw = referenceBaseUrl || '/reference/';
  const base = raw.endsWith('/') ? raw : `${raw}/`;
  return new URL(`${id}.json`, new URL(base, window.location.origin)).toString();
}

function loadDataset(id: string, referenceBaseUrl: string | undefined): Promise<ReferenceOption[]> {
  const cached = datasetCache.get(id);
  if (cached) return cached;
  const pending = fetch(referenceUrl(id, referenceBaseUrl))
    .then((res) => {
      if (!res.ok) throw new Error(`reference dataset ${id} → ${res.status}`);
      return res.json();
    })
    .then(flattenReferenceDataset)
    .catch((err: unknown) => {
      // Drop the failed promise so a later mount can retry rather than being
      // stuck with the failure for the session.
      datasetCache.delete(id);
      throw err;
    });
  datasetCache.set(id, pending);
  return pending;
}

export function ReferenceAutocompleteWidget({
  id,
  value,
  disabled,
  readonly,
  onChange,
  placeholder,
  options,
}: WidgetProps) {
  const opts = options as { source?: string; subtitleFields?: string[] } | undefined;
  const source = opts?.source;
  // Unknown field names are dropped; an explicit (possibly empty) list wins over
  // the default, so `[]` means name-only.
  const subtitleFields: SubtitleField[] = Array.isArray(opts?.subtitleFields)
    ? opts.subtitleFields.filter((f): f is SubtitleField =>
        (SUBTITLE_FIELDS as readonly string[]).includes(f),
      )
    : DEFAULT_SUBTITLE;

  const { collegeDataset, referenceBaseUrl } = useFormRuntimeConfig();

  const [text, setText] = React.useState<string>((value as string) ?? '');
  const [dataset, setDataset] = React.useState<ReferenceOption[]>([]);
  const [open, setOpen] = React.useState(false);
  const blurRef = React.useRef<number | undefined>(undefined);

  // Keep the input in sync when RJSF pushes a new value (e.g. a prefill).
  React.useEffect(() => {
    setText((value as string) ?? '');
  }, [value]);

  React.useEffect(() => {
    if (!source) return undefined;
    let live = true;
    void loadDataset(resolveDatasetId(source, collegeDataset), referenceBaseUrl)
      .then((loaded) => {
        if (live) setDataset(loaded);
      })
      .catch(() => {
        // A load failure leaves the field as a plain text input — no
        // suggestions, but the typed value is still captured.
        if (live) setDataset([]);
      });
    return () => {
      live = false;
    };
  }, [source, collegeDataset, referenceBaseUrl]);

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
   * The secondary line under an option's name. Ordered per the marker's
   * `subtitle` config (default: district only) — when the dataset is
   * state-scoped by deployment, `state` is the same for every option, so
   * district is usually the only one that distinguishes anything.
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
          {suggestions.map((o, i) => {
            const sub = subtitle(o);
            return (
              <li
                key={`${o.name}-${i}`}
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
