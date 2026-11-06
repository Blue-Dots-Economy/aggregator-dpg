'use client';

/**
 * Form state for creating a registration link (web app).
 */

import { useState } from 'react';
import type { CreateLinkFormValues } from './link-form';

/** The first postal address on the aggregator profile, as the API returns it. */
type ProfileAddress = Record<string, string | undefined>;

/** Registration mode used by default when the network config declares it. */
const PREFERRED_REGISTRATION_MODE = 'form';

/** Inputs the form's starting values are derived from. */
export interface CreateLinkFormSources {
  /** First address on the aggregator profile, if any. */
  address: ProfileAddress | undefined;
  /** Registration mode keys from the network config, in config order. */
  modeKeys: string[];
}

/**
 * Starting values of the create form.
 *
 * State, district and event location come from the first postal address. The
 * address is one free-text line; `addressRegion` and `addressLocality` exist
 * only on older rows, and state and district are not parsed from free text.
 * The mode is `form` if declared, else the first mode, else empty.
 */
export function createLinkDefaults({
  address,
  modeKeys,
}: CreateLinkFormSources): CreateLinkFormValues {
  const fallbackMode = modeKeys.includes(PREFERRED_REGISTRATION_MODE)
    ? PREFERRED_REGISTRATION_MODE
    : (modeKeys[0] ?? '');
  return {
    state: address?.addressRegion || '',
    district: address?.addressLocality || '',
    lever_event: '',
    event_date: '',
    event_location: address?.addressLocality || address?.streetAddress || '',
    registration_mode: fallbackMode,
    tags: '',
  };
}

/** What {@link useCreateLinkForm} returns. */
export interface CreateLinkForm {
  /** Current values: the user's edits over the derived starting values. */
  values: CreateLinkFormValues;
  /** Sets one field to what the user entered. */
  setField: (key: keyof CreateLinkFormValues, value: string) => void;
  /** Drops every edit, so the form shows its starting values again. */
  reset: () => void;
}

/**
 * Holds the user's edits to the create form.
 *
 * Starting values are derived on each render, so a profile or config that
 * loads later fills every field the user has not touched.
 */
export function useCreateLinkForm(sources: CreateLinkFormSources): CreateLinkForm {
  const [edits, setEdits] = useState<Partial<CreateLinkFormValues>>({});
  const values: CreateLinkFormValues = { ...createLinkDefaults(sources), ...edits };
  return {
    values,
    setField: (key, value) => setEdits((prev) => ({ ...prev, [key]: value })),
    reset: () => setEdits({}),
  };
}
