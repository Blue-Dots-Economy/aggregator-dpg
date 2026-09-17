/**
 * Runtime configuration for the schema-driven form widgets (address
 * autocomplete + the reference/college picker).
 *
 * Kept free of `next/*` imports so it is unit-testable and importable from both
 * server and client code.
 *
 * `getFormRuntimeConfig()` reads `process.env`, so it must only be called where
 * that is a RUNTIME read — server components, server actions and route
 * handlers. Client components take the resolved object from
 * `FormRuntimeConfigProvider` instead.
 *
 * Deliberately NOT `NEXT_PUBLIC_*`: Next inlines those at `next build`, which
 * would bake a deployment's Maps key and college region into the image and make
 * either one require a rebuild to change. That is the same trap #752 fixed for
 * `ENABLED_LANGUAGES`, and the reason this mirrors `i18n/config.ts` +
 * `EnabledLocalesProvider` rather than reading the environment in the widget.
 *
 * The Signals UI reads the equivalent values from `window.__DPG_UI_CONFIG__`
 * (`VITE_GOOGLE_MAPS_API_KEY`, `VITE_PHOTON_URL`, `VITE_COLLEGE_DATASET`,
 * `VITE_REFERENCE_BASE_URL`); the names here drop the Vite prefix but keep the
 * same meaning and the same defaults.
 *
 * @module apps/web/lib/form-runtime-config
 */

/**
 * Values the form widgets need at runtime. Every field is optional-by-absence:
 * with an empty object the widgets degrade to plain text inputs and the
 * key-less Photon geocoder, which is exactly the behaviour before this feature.
 */
export interface FormRuntimeConfig {
  /**
   * Google Maps JS API key, BROWSER-side. Absent → the address widgets fall
   * back to Photon. Referrer-restricted and scoped to Places at the Google
   * console; it is served to the browser by design.
   */
  googleMapsApiKey?: string;
  /** Override for the key-less Photon endpoint. Absent → Photon's public host. */
  photonUrl?: string;
  /**
   * Region code selecting which college dataset the reference picker loads:
   * `colleges-<code>.json`. Mirrors Signals' `VITE_COLLEGE_DATASET`, including
   * its `ka` default, so the same region code means the same file in both apps.
   */
  collegeDataset: string;
  /**
   * Base URL the reference datasets are served from. Empty → the app's own
   * `/reference/`, where a deployment mounts its ConfigMap. The datasets are
   * NOT committed to this repo — they are large, always shadowed by that
   * ConfigMap in a real deployment, and a committed copy cannot stay in step
   * with canonical (this repo's own pre-commit prettier rewrites it). So local
   * development points this at canonical directly; see `infra/env.template`.
   * A remote host must send permissive CORS headers, since the browser fetches
   * it directly.
   */
  referenceBaseUrl?: string;
}

/** Region used when `COLLEGE_DATASET` is unset. Must match the Helm chart default. */
export const DEFAULT_COLLEGE_DATASET = 'ka';

/**
 * Trims an environment value and treats blank as absent.
 *
 * Helm renders an unset value as `""` rather than omitting the variable, so a
 * plain `process.env.X ?? undefined` would hand the widgets an empty string and
 * they would treat it as "configured".
 *
 * @param raw - The raw environment value, if any.
 * @returns The trimmed value, or `undefined` when unset or blank.
 */
function cleaned(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolves the form widgets' runtime configuration from the environment.
 *
 * SERVER ONLY — see the module note. Call it in a server component and publish
 * the result through {@link FormRuntimeConfigProvider}.
 *
 * @returns The resolved configuration, with `collegeDataset` always populated.
 */
export function getFormRuntimeConfig(): FormRuntimeConfig {
  const googleMapsApiKey = cleaned(process.env.GOOGLE_MAPS_API_KEY);
  const photonUrl = cleaned(process.env.PHOTON_URL);
  const referenceBaseUrl = cleaned(process.env.REFERENCE_BASE_URL);
  return {
    ...(googleMapsApiKey ? { googleMapsApiKey } : {}),
    ...(photonUrl ? { photonUrl } : {}),
    ...(referenceBaseUrl ? { referenceBaseUrl } : {}),
    collegeDataset: cleaned(process.env.COLLEGE_DATASET) ?? DEFAULT_COLLEGE_DATASET,
  };
}
