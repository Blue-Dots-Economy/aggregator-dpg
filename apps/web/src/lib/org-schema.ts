/**
 * Organisation schema helpers (`apps/web`), shared by the org registration
 * form and the console's organisation details.
 *
 * The deployment's `org-registration.v1.json` lists the organisation's
 * schema-driven fields. These helpers read the markers on its properties the
 * same way the API does:
 *
 * - `x-network-domains: true` — choices are the network's domains.
 * - `x-check: "gstin"` — the GSTIN check character is verified too.
 * - `x-updatable: true` — the owner may change the field in the console.
 *
 * No `next/*` or `fs` imports, so client components can use it.
 *
 * @module apps/web/src/lib/org-schema
 */

import type { FormValidation, RJSFSchema } from '@rjsf/utils';
import { isValidGstin } from '@aggregator-dpg/shared-primitives/org-details';
import { isJsonObject, jsonObjectOr, schemaProperties } from '@/lib/json-object';
import { addFieldError } from '@/lib/rjsf-field-error';

/** One network domain, as the console and forms show it. */
export interface OrgDomainOption {
  id: string;
  label: string;
}

/**
 * Registration-only properties: handled by the form's fixed parts and never
 * shown among the schema fields in the console.
 */
const FIXED_KEYS: ReadonlySet<string> = new Set([
  'display_name',
  'parent_id',
  'state',
  'owner',
  'consent',
  'address',
]);

/** Message for a GSTIN that fails its check character, unless the schema words it. */
const GSTIN_MESSAGE = 'Please enter a valid GSTIN.';

type JsonRecord = Record<string, unknown>;

/** A schema's `properties` map. Definitions may be objects or booleans. */
type SchemaProperties = NonNullable<RJSFSchema['properties']>;

/**
 * Fills the choices of every `x-network-domains` property with the network's
 * domains: ids in the schema, labels in the UI schema. Returns copies; leaves
 * both unchanged when there are no domains.
 *
 * @param schema - The org-registration schema.
 * @param uiSchema - Its UI schema.
 * @param domains - The network's domains, in configuration order.
 * @returns The patched schema and UI schema.
 */
export function applyNetworkDomains(
  schema: RJSFSchema,
  uiSchema: JsonRecord,
  domains: readonly OrgDomainOption[],
): { schema: RJSFSchema; uiSchema: JsonRecord } {
  if (domains.length === 0) return { schema, uiSchema };
  const ids = domains.map((d) => d.id);
  const labels = domains.map((d) => d.label);
  const properties: SchemaProperties = {};
  const ui: JsonRecord = { ...uiSchema };
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (!isJsonObject(prop) || prop['x-network-domains'] !== true) {
      properties[name] = prop;
      continue;
    }
    properties[name] =
      prop['type'] === 'array'
        ? {
            ...prop,
            items: {
              ...(isJsonObject(prop['items']) ? prop['items'] : {}),
              type: 'string',
              enum: ids,
            },
          }
        : { ...prop, enum: ids };
    ui[name] = { ...(isJsonObject(ui[name]) ? ui[name] : {}), 'ui:enumNames': labels };
  }
  return { schema: { ...schema, properties }, uiSchema: ui };
}

/**
 * The form-level check for `x-check: "gstin"` fields, for RJSF's
 * `customValidate`: adds the field's message when the check character is wrong.
 *
 * @param schema - The schema the form renders.
 * @returns A `customValidate` function.
 */
export function gstinCustomValidate(schema: RJSFSchema) {
  const checked = Object.entries(schemaProperties(schema)).filter(
    ([, p]) => p['x-check'] === 'gstin',
  );
  return <T>(formData: T | undefined, errors: FormValidation<T>): FormValidation<T> => {
    const data = jsonObjectOr(formData);
    for (const [name, prop] of checked) {
      const value = data[name];
      if (typeof value !== 'string' || value.trim() === '' || isValidGstin(value)) continue;
      const authored = prop['x-error-message'];
      addFieldError(
        errors,
        [name],
        typeof authored === 'string' && authored.trim() ? authored : GSTIN_MESSAGE,
      );
    }
    return errors;
  };
}

/**
 * The schema's own fields (everything but the registration-only parts), in
 * the UI schema's order.
 *
 * @param schema - The org-registration schema.
 * @param uiSchema - Its UI schema, whose `ui:order` sets the order.
 * @returns Field names.
 */
export function orgSchemaFields(schema: RJSFSchema, uiSchema: JsonRecord): string[] {
  const names = Object.keys(schema.properties ?? {}).filter((name) => !FIXED_KEYS.has(name));
  const order: unknown[] = Array.isArray(uiSchema['ui:order']) ? uiSchema['ui:order'] : [];
  const ranked = order.filter(
    (name): name is string => typeof name === 'string' && names.includes(name),
  );
  return [...ranked, ...names.filter((name) => !ranked.includes(name))];
}

/**
 * The console's view of the org schema: only its own fields, nothing
 * required, and every field read-only unless `editable` and marked
 * `x-updatable`.
 *
 * @param schema - The org-registration schema (network domains applied).
 * @param uiSchema - Its UI schema (network domain labels applied).
 * @param editable - Whether the viewer may edit (the org's owner).
 * @returns The schema, UI schema and the editable field names.
 */
export function consoleOrgSchema(
  schema: RJSFSchema,
  uiSchema: JsonRecord,
  editable: boolean,
): { schema: RJSFSchema; uiSchema: JsonRecord; updatable: string[] } {
  const all: SchemaProperties = schema.properties ?? {};
  const props = schemaProperties(schema);
  const fields = orgSchemaFields(schema, uiSchema);
  const updatable = editable ? fields.filter((name) => props[name]?.['x-updatable'] === true) : [];
  const ui: JsonRecord = { 'ui:order': [...fields, '*'] };
  for (const name of fields) {
    const own = isJsonObject(uiSchema[name]) ? uiSchema[name] : {};
    ui[name] = updatable.includes(name) ? own : { ...own, 'ui:readonly': true };
  }
  return {
    schema: {
      ...(schema.$schema ? { $schema: schema.$schema } : {}),
      type: 'object',
      properties: Object.fromEntries(fields.map((name) => [name, all[name] ?? {}])),
    },
    uiSchema: ui,
    updatable,
  };
}

/**
 * A schema field's value as text for a read-only view: choices by their
 * labels, lists joined, empty as `null`.
 *
 * @param prop - The field's schema.
 * @param ui - The field's UI schema.
 * @param value - The stored value.
 * @returns The text, or `null` when there is nothing to show.
 */
export function orgFieldText(prop: JsonRecord, ui: JsonRecord, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const items = isJsonObject(prop['items']) ? prop['items'] : prop;
  const choices: unknown[] = Array.isArray(items['enum']) ? items['enum'] : [];
  const names: unknown[] = Array.isArray(ui['ui:enumNames']) ? ui['ui:enumNames'] : [];
  const label = (v: unknown): string => {
    const i = choices.indexOf(v);
    return i >= 0 && names[i] !== undefined ? String(names[i]) : String(v);
  };
  if (Array.isArray(value)) return value.length > 0 ? value.map(label).join(', ') : null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return label(value);
}
