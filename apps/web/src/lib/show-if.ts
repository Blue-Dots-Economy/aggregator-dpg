/**
 * Conditional form-field visibility for schema-driven RJSF forms.
 *
 * Implements the custom `x-show-if` JSON-Schema keyword: a field declares
 * `"x-show-if": { controlField: [allowedValue, ...] }` and is rendered only
 * while the control field's value is in the allowed list. Matches the
 * Signals-DPG implementation. Part of the `web` app.
 *
 * @module apps/web/lib/show-if
 */

import type { RJSFSchema } from '@rjsf/utils';
import { isJsonObject, schemaProperties } from '@/lib/json-object';

/** The custom keyword: control field name → values that reveal the dependent field. */
type ShowIfMap = Record<string, unknown[]>;

interface FieldSchema {
  'x-show-if'?: ShowIfMap;
  [key: string]: unknown;
}

/** True outside production; enables authoring warnings. */
const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Decides whether a single field is visible under the current form values.
 *
 * A field with no `x-show-if` is always visible. Otherwise every control entry
 * must match; an array control matches if any selected value is allowed.
 *
 * @param fieldSchema - The field's JSON Schema (may carry `x-show-if`).
 * @param formData - The current top-level form values.
 * @returns `true` when the field should be shown, `false` when it is hidden.
 */
export function isFieldVisible(
  fieldSchema: FieldSchema,
  formData: Record<string, unknown>,
): boolean {
  const rule = fieldSchema['x-show-if'];
  if (!rule || typeof rule !== 'object') return true;
  return Object.entries(rule).every(([controlField, allowed]) => {
    if (!Array.isArray(allowed)) return false;
    const value = formData[controlField];
    if (Array.isArray(value)) {
      // Multi-select: visible if any selected value is allowed.
      return value.some((v) => allowed.includes(v));
    }
    if (value === undefined || value === null || value === '') return false;
    return allowed.includes(value);
  });
}

export interface ResolveResult {
  /** Schema with hidden properties removed from `properties` and `required`. */
  schema: RJSFSchema;
  /** formData with hidden fields' values cleared. */
  formData: Record<string, unknown>;
  /** Names of the hidden properties (sorted). */
  hidden: string[];
}

/**
 * Prunes fields hidden by `x-show-if` from a schema and clears their values.
 *
 * Hiding a control also hides its dependents. Does not mutate its inputs. In
 * development, warns when `x-show-if` names a control field that does not exist.
 *
 * @param schema - The JSON Schema whose top-level properties may carry `x-show-if`.
 * @param formData - The current top-level form values.
 * @returns The pruned schema, the cleared formData, and the sorted hidden-field names.
 */
export function resolveVisibleSchema(
  schema: RJSFSchema,
  formData: Record<string, unknown>,
): ResolveResult {
  const allProps: Record<string, FieldSchema> = schemaProperties(schema);
  const propNames = Object.keys(allProps);

  if (IS_DEV) {
    for (const [name, prop] of Object.entries(allProps)) {
      const rule = prop?.['x-show-if'];
      if (rule && typeof rule === 'object') {
        for (const control of Object.keys(rule)) {
          if (!(control in allProps)) {
            console.warn(
              `[x-show-if] field "${name}" references unknown control field "${control}"`,
            );
          }
        }
      }
    }
  }

  // Repeat until the hidden set stops growing; clearing values only hides more.
  let hidden = new Set<string>();
  let working: Record<string, unknown> = { ...formData };
  for (;;) {
    const next = new Set<string>();
    for (const name of propNames) {
      if (!isFieldVisible(allProps[name]!, working)) next.add(name);
    }
    const stable = next.size === hidden.size && [...next].every((n) => hidden.has(n));
    if (stable) break;
    hidden = next;
    working = { ...formData };
    for (const name of hidden) delete working[name];
  }

  return {
    schema: pruneHiddenFields(schema, [...hidden]),
    formData: working,
    hidden: [...hidden].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Removes the named top-level fields from a schema's `properties` and `required`.
 *
 * Does not mutate its input. {@link resolveVisibleSchema} decides which fields
 * are hidden; this builds the schema for a given hidden set, so a caller can
 * memoise on that set.
 *
 * @param schema - The JSON Schema to prune.
 * @param hidden - Names of the top-level properties to remove.
 * @returns The schema without those fields.
 */
export function pruneHiddenFields(schema: RJSFSchema, hidden: readonly string[]): RJSFSchema {
  const hiddenSet = new Set(hidden);
  const properties = Object.fromEntries(
    Object.entries(schema.properties ?? {}).filter(([name]) => !hiddenSet.has(name)),
  );
  const pruned: RJSFSchema = { ...schema, properties };
  if (Array.isArray(schema.required)) {
    pruned.required = schema.required.filter((r) => !hiddenSet.has(r));
  }
  return pruned;
}

/** Copies an object without its `x-show-if` keys, at every depth. */
function stripObject(node: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'x-show-if') continue;
    result[key] = stripShowIf(value);
  }
  return result;
}

/**
 * Recursively removes the custom `x-show-if` keyword from a schema tree.
 *
 * Ajv must not see this keyword; {@link resolveVisibleSchema} handles it
 * first. Does not mutate its input. An object comes back as an object, an
 * array as an array, and any other value as it is.
 *
 * @param schema - Any JSON Schema node (object, array, or primitive).
 * @returns An equivalent schema with every `x-show-if` removed.
 */
export function stripShowIf(schema: RJSFSchema): RJSFSchema;
export function stripShowIf(schema: unknown): unknown;
export function stripShowIf(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((s) => stripShowIf(s));
  return isJsonObject(schema) ? stripObject(schema) : schema;
}
