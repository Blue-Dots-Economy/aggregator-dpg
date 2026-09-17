'use client';

/**
 * Address autocomplete for a single `location`-marked schema field.
 *
 * Ported from Signals-DPG
 * `apps/ui/src/components/forms/custom-widgets/location-autocomplete-widget.tsx`
 * so the same network.json schema behaves the same way in the public
 * registration form as it does in the Signals profile form. Two deliberate
 * differences from that original:
 *
 *  1. The form context is read off `registry.formContext`, NOT the
 *     `formContext` prop. RJSF v6 stopped spreading it onto widget props — it
 *     only lives on the registry — so the prop is always `undefined` and every
 *     location callback silently no-ops. That is signals-dpg#506, which this
 *     file must not reproduce: `WidgetProps` extends an index-signature type, so
 *     reading the dead prop type-checks cleanly and fails only at runtime.
 *  2. Errors are left to `FieldTemplate`, which already renders the message and
 *     reddens any `.bd-input` beneath it. The Signals copy draws its own,
 *     because its host template does not.
 *
 * @module apps/web/components/forms/custom-widgets/LocationAutocompleteWidget
 */

import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { Input } from '../../ui/Input';
import { cn } from '../../../lib/cn';
import { getGeoProvider } from '../../../lib/geo/provider';
import { useFormRuntimeConfig } from '../../../lib/FormRuntimeConfigProvider';
import { useSuggestionKeyboard } from './use-suggestion-keyboard';
import type { GeoComponents, GeoSuggestion } from '../../../lib/geo/types';

/**
 * A selected place reported to the page.
 *
 * `components` is carried so this stays shape-compatible with the Signals
 * widget, but nothing reads it on either side today: the exact point is what
 * gets submitted, and Signals jitters a `private` field's coordinate at its own
 * storage choke point, so no client-side coarsening is needed or performed.
 */
export interface ResolvedPlace {
  lat: number;
  lng: number;
  components?: GeoComponents;
}

export interface LocationFormContext {
  onLocationResolved?: (place: ResolvedPlace | null) => void;
}

/** How close to the viewport bottom the input may sit before the list flips up. */
const DROP_UP_THRESHOLD_PX = 260;
/** Shortest query worth sending to a geocoder. */
const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 300;
/** Long enough for a suggestion's mousedown to land before blur closes the list. */
const BLUR_CLOSE_MS = 150;

export function LocationAutocompleteWidget({
  id,
  value,
  disabled,
  readonly,
  onChange,
  placeholder,
  registry,
  options,
}: WidgetProps) {
  const t = useTranslations('form');
  const ctx = (registry?.formContext ?? {}) as LocationFormContext;
  const isPrimary =
    (options as { isPrimaryLocation?: boolean } | undefined)?.isPrimaryLocation === true;

  const [text, setText] = React.useState<string>((value as string) ?? '');
  const [suggestions, setSuggestions] = React.useState<GeoSuggestion[]>([]);
  const [open, setOpen] = React.useState(false);
  // Open the list upward when the input sits near the bottom of the viewport,
  // so the suggestions aren't hidden below the fold.
  const [dropUp, setDropUp] = React.useState(false);

  const inputRef = React.useRef<HTMLInputElement>(null);
  const debounceRef = React.useRef<number | undefined>(undefined);
  const blurRef = React.useRef<number | undefined>(undefined);
  const abortRef = React.useRef<AbortController | null>(null);

  const config = useFormRuntimeConfig();
  const provider = React.useMemo(
    () =>
      getGeoProvider({
        ...(config.googleMapsApiKey ? { googleMapsApiKey: config.googleMapsApiKey } : {}),
        ...(config.photonUrl ? { photonUrl: config.photonUrl } : {}),
      }),
    [config.googleMapsApiKey, config.photonUrl],
  );

  // Keep the input in sync when RJSF pushes a new value (e.g. a prefill). This
  // intentionally does NOT search — searching is driven only by typing (see
  // runSearch), so choosing a suggestion (which calls onChange, updating
  // `value`) never re-opens the dropdown.
  React.useEffect(() => {
    setText((value as string) ?? '');
  }, [value]);

  // Cancel any pending work on unmount.
  React.useEffect(
    () => () => {
      window.clearTimeout(debounceRef.current);
      window.clearTimeout(blurRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  function runSearch(query: string) {
    window.clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      void provider.suggest(q, controller.signal).then((results) => {
        if (controller.signal.aborted) return;
        setSuggestions(results);
        setOpen(results.length > 0);
        if (results.length > 0) {
          const rect = inputRef.current?.getBoundingClientRect();
          setDropUp(!!rect && window.innerHeight - rect.bottom < DROP_UP_THRESHOLD_PX);
        }
      });
    }, DEBOUNCE_MS);
  }

  function handleInput(next: string) {
    setText(next);
    // Emit `undefined` (not "") when cleared, so a required location field goes
    // back to invalid — an empty string counts as "present" for JSON-Schema
    // `required`, which would let an emptied location slip past validation.
    onChange(next === '' ? undefined : next);
    // Freshly typed text is no longer a resolved place, so drop any prior
    // coordinate: the submit path then re-geocodes rather than attaching a
    // coordinate to an address the user has since edited.
    if (isPrimary) ctx.onLocationResolved?.(null);
    runSearch(next);
  }

  function choose(suggestion: GeoSuggestion) {
    // Cancel pending/in-flight work so choosing never re-opens the list.
    window.clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setText(suggestion.label);
    onChange(suggestion.label);
    setSuggestions([]);
    setOpen(false);
    // Only the primary field's coordinate is persisted; secondary fields are
    // autocomplete-only, matching Signals.
    if (isPrimary) {
      ctx.onLocationResolved?.({
        lat: suggestion.lat,
        lng: suggestion.lng,
        ...(suggestion.components ? { components: suggestion.components } : {}),
      });
    }
  }

  const { activeIndex, setActiveIndex, optionId, activeDescendantId, listboxId, onKeyDown } =
    useSuggestionKeyboard({
      items: suggestions,
      open,
      onOpen: () => setOpen(true),
      onClose: () => setOpen(false),
      onSelect: (index) => {
        const suggestion = suggestions[index];
        if (suggestion) choose(suggestion);
      },
      idPrefix: id,
    });

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id={id}
        value={text}
        disabled={Boolean(disabled || readonly)}
        autoComplete="off"
        placeholder={placeholder || t('location_search_placeholder')}
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendantId}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(suggestions.length > 0)}
        onBlur={() => {
          // Delay the close so a suggestion's mousedown still registers.
          blurRef.current = window.setTimeout(() => setOpen(false), BLUR_CLOSE_MS);
        }}
      />
      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className={cn(
            'absolute left-0 z-50 max-h-[280px] w-full overflow-y-auto rounded-[10px] border border-(--bd-border) bg-(--bd-card) p-1 shadow-lg',
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          {suggestions.map((s, i) => (
            // `role="option"` on the item itself, not a nested <button>: an
            // option is what `aria-activedescendant` can point at, and a
            // listbox may only contain options.
            <li
              key={`${s.lat},${s.lng},${i}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              className={cn(
                'cursor-pointer rounded-[8px] px-2 py-2 text-[14px] transition-colors',
                i === activeIndex
                  ? 'bg-(--bd-primary-50) text-(--bd-primary-600)'
                  : 'hover:bg-(--bd-primary-50)',
              )}
              // onMouseDown (not onClick) so selection runs before the input's
              // blur fires; preventDefault keeps focus from flicking away.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
              // Hovering moves the keyboard highlight too, so the two never
              // disagree about which option Enter would take.
              onMouseEnter={() => setActiveIndex(i)}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
