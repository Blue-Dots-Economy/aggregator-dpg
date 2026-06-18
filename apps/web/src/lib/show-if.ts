/**
 * Conditional form-field visibility for schema-driven RJSF forms.
 *
 * Implements the custom `x-show-if` JSON-Schema keyword: a field declares
 * `"x-show-if": { controlField: [allowedValue, ...] }` and is rendered only
 * while the control field's current value is in the allowed list. Mirrors the
 * Signals-DPG implementation so the aggregator's registration-link / profile
 * forms behave identically to the signals UI when rendering the same schema.
 *
 * Belongs to the `web` app (portal + BFF) of the Aggregator DPG.
 *
 * @module apps/web/lib/show-if
 */

import type { RJSFSchema } from '@rjsf/utils';

/** The custom keyword: control field name → values that reveal the dependent field. */
type ShowIfMap = Record<string, unknown[]>;

interface FieldSchema {
  'x-show-if'?: ShowIfMap;
  [key: string]: unknown;
}

/** True only outside a production build — gates authoring-time warnings. */
const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Decides whether a single field is visible under the current form values.
 *
 * A field with no `x-show-if` is always visible. When present, every
 * `(controlField → allowed)` entry must be satisfied (AND across keys); an
 * array-valued control matches if any selected value is allowed.
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
      // multi-select control → visible if any selected value is allowed
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
 * Removes hidden top-level properties from `properties` and `required`, and
 * deletes their values from a copy of `formData`. Chain-aware: iterates to a
 * fixpoint so hiding a control also hides (and clears) any dependents that key
 * off it. Pure — never mutates its inputs. In development, emits a
 * `console.warn` when an `x-show-if` references a control field that does not
 * exist (an authoring typo).
 *
 * @param schema - The JSON Schema whose top-level properties may carry `x-show-if`.
 * @param formData - The current top-level form values.
 * @returns The pruned schema, the cleared formData, and the sorted hidden-field names.
 */
export function resolveVisibleSchema(
  schema: RJSFSchema,
  formData: Record<string, unknown>,
): ResolveResult {
  const allProps = (schema.properties ?? {}) as Record<string, FieldSchema>;
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

  // Fixpoint. Clearing a value can only hide more fields (never reveal one), so
  // the hidden set grows monotonically and converges in at most propNames steps.
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

  const prunedProps: Record<string, unknown> = {};
  for (const name of propNames) {
    if (!hidden.has(name)) prunedProps[name] = allProps[name];
  }
  const prunedSchema: RJSFSchema = {
    ...schema,
    properties: prunedProps as RJSFSchema['properties'],
  };
  if (Array.isArray(schema.required)) {
    prunedSchema.required = (schema.required as string[]).filter((r) => !hidden.has(r));
  }

  return { schema: prunedSchema, formData: working, hidden: [...hidden].sort() };
}

/**
 * Recursively removes the custom `x-show-if` keyword from a schema tree.
 *
 * `x-show-if` is consumed by {@link resolveVisibleSchema} before validation;
 * Ajv must never see it (an unknown keyword would warn or fail under strict
 * mode). Pure — returns a new schema and never mutates its input.
 *
 * @param schema - Any JSON Schema node (object, array, or primitive).
 * @returns An equivalent schema with every `x-show-if` removed.
 */
export function stripShowIf<T>(schema: T): T {
  if (Array.isArray(schema)) {
    return schema.map((s) => stripShowIf(s)) as unknown as T;
  }
  if (schema === null || typeof schema !== 'object') return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'x-show-if') continue;
    result[key] = stripShowIf(value);
  }
  return result as T;
}
