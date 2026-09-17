'use client';

/**
 * Carries the runtime-resolved {@link FormRuntimeConfig} across the
 * server/client boundary for the schema-driven form widgets.
 *
 * Exists for the same reason as `EnabledLocalesProvider`: these values must stay
 * RUNTIME settings. A client component cannot read them — Next.js only exposes
 * `NEXT_PUBLIC_*` to the browser, and those are inlined at `next build`. The
 * root layout is a server component that every route nests under, so it resolves
 * the config once per request and publishes it here.
 *
 * Consumers outside a provider get the defaults, which degrade to plain text
 * inputs and the key-less geocoder rather than throwing — a mis-wired subtree
 * loses autocomplete, it does not lose the form.
 *
 * @module apps/web/lib/FormRuntimeConfigProvider
 */

import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_COLLEGE_DATASET, type FormRuntimeConfig } from './form-runtime-config';

const FormRuntimeConfigContext = createContext<FormRuntimeConfig | null>(null);

/** Used when no provider is above the consumer: no key, no overrides. */
const FALLBACK_CONFIG: FormRuntimeConfig = { collegeDataset: DEFAULT_COLLEGE_DATASET };

/**
 * Publishes the resolved form runtime config to client components.
 *
 * @param value - The resolved config, from `getFormRuntimeConfig()` on the server.
 * @param children - Subtree that may call `useFormRuntimeConfig`.
 */
export function FormRuntimeConfigProvider({
  value,
  children,
}: Readonly<{ value: FormRuntimeConfig; children: ReactNode }>) {
  return (
    <FormRuntimeConfigContext.Provider value={value}>{children}</FormRuntimeConfigContext.Provider>
  );
}

/**
 * Reads the form runtime config published by the root layout.
 *
 * @returns The resolved config, or the no-key defaults outside a provider.
 */
export function useFormRuntimeConfig(): FormRuntimeConfig {
  return useContext(FormRuntimeConfigContext) ?? FALLBACK_CONFIG;
}
