/**
 * Schema and uiSchema builders for the public registration form (web app).
 */
import type { RJSFSchema, StrictRJSFSchema } from '@rjsf/utils';
import { z } from 'zod';
import type { LinkIdentity } from '@/lib/registration-link';
import { isRecord } from './is-record';

/** Prefix of an `items.$ref` that points into the schema's own `$defs`. */
const DEFS_REF_PREFIX = '#/$defs/';

/** A property or `items` value in a JSON Schema: a schema, a boolean schema or a tuple. */
type SchemaNode = NonNullable<StrictRJSFSchema['items']>;

/**
 * The part of `x-form-layout` the field order reads. A layout that does not
 * match is ignored and the default order is used.
 */
const FormLayoutOrderSchema = z.object({
  sections: z.array(z.object({ fields: z.array(z.string()).optional() })).optional(),
});

/**
 * Whether a schema node is a schema object, not a boolean schema or a tuple.
 *
 * @param node - A property or `items` value from a JSON Schema.
 */
function isSchemaObject(node: SchemaNode | undefined): node is StrictRJSFSchema {
  return typeof node === 'object' && !Array.isArray(node);
}

/**
 * Maps a schema property's custom markers to a uiSchema entry for a custom widget.
 *
 * Uses the same markers as the Signals profile form:
 *
 *  - `location: "primary" | "secondary"`: address autocomplete. Only a primary
 *    field's picked coordinate is saved.
 *  - `x-reference-source`: autocomplete backed by an external dataset, either a
 *    source id or `{ source, subtitle }`.
 *
 * @param def - The property's JSON Schema.
 * @param type - The property's declared `type`, used to pick the array variant.
 * @returns A uiSchema entry for the field, or `null` if no marker applies.
 */
export function resolveMarkerUiSchema(
  def: Record<string, unknown>,
  type: unknown,
): Record<string, unknown> | null {
  const locationRole = def['location'];
  if (locationRole === 'primary' || locationRole === 'secondary') {
    const isArray = type === 'array';
    return {
      'ui:widget': isArray ? 'location-multi' : 'location-autocomplete',
      // Only the multi-row array variant spans both columns. The single-value
      // variant stays half width so the cell beside it is not left empty.
      ...(isArray ? { 'ui:colSpan': 2 } : {}),
      'ui:options': { isPrimaryLocation: locationRole === 'primary' },
    };
  }

  const marker = def['x-reference-source'];
  let source: string | undefined;
  let subtitleFields: string[] | undefined;
  if (typeof marker === 'string') {
    source = marker;
  } else if (isRecord(marker)) {
    const markerSource = marker['source'];
    const markerSubtitle = marker['subtitle'];
    if (typeof markerSource === 'string') source = markerSource;
    if (Array.isArray(markerSubtitle)) {
      subtitleFields = markerSubtitle.filter((s): s is string => typeof s === 'string');
    }
  }
  if (source) {
    return {
      'ui:widget': 'reference-autocomplete',
      // No colSpan: a single input stays half width.
      'ui:options': { source, ...(subtitleFields ? { subtitleFields } : {}) },
    };
  }

  return null;
}

/**
 * Builds the schema the public form renders from the link's schema.
 *
 * Removes the schema title/description (the page header has its own) and
 * `participant_id`, which is bulk-upload only; the server creates one. Only
 * identity fields stay required, and minimum constraints are removed from the
 * other fields, so a partial profile validates. Does not change `schema`.
 *
 * @param schema - The link's profile schema.
 * @param identity - Identity field names for the domain.
 * @returns A new schema for the form.
 */
export function buildFormSchema(
  schema: RJSFSchema,
  identity: LinkIdentity | undefined,
): RJSFSchema {
  // Deep clone: the transforms below change nested objects, which must not
  // leak back into the `schema` prop.
  const clone: RJSFSchema = structuredClone(schema);
  delete clone.title;
  delete clone.description;
  if (clone.properties && 'participant_id' in clone.properties) {
    const { participant_id: _omit, ...rest } = clone.properties;
    clone.properties = rest;
  }
  // Partial profiles are accepted: only identity fields stay required.
  // Signals marks an incomplete item `draft`. The server applies the same rule.
  const identityKeys = new Set(
    [identity?.name, identity?.phone, identity?.email].filter(
      (k): k is string => typeof k === 'string' && k.length > 0,
    ),
  );
  if (Array.isArray(clone.required)) {
    clone.required = clone.required.filter((r) => identityKeys.has(r));
  }
  const props = clone.properties;
  if (!props) return clone;

  // Inline `items.$ref` to `#/$defs/<x>` so RJSF's checkboxes widget gets its
  // enum options. RJSF does not resolve these refs for widget options.
  const defs = clone.$defs ?? {};
  for (const def of Object.values(props)) {
    if (!isSchemaObject(def) || def.type !== 'array') continue;
    const items = def.items;
    if (isSchemaObject(items) && items.$ref?.startsWith(DEFS_REF_PREFIX)) {
      const target = defs[items.$ref.slice(DEFS_REF_PREFIX.length)];
      if (target) {
        // Replace the ref with the resolved enum/type.
        const { $ref: _r, ...keep } = items;
        def.items = isSchemaObject(target) ? { ...target, ...keep } : keep;
      }
    }
    // RJSF fills `enumOptions` for array widgets only with `uniqueItems: true`.
    if (isSchemaObject(def.items) && Array.isArray(def.items.enum)) {
      def.uniqueItems = true;
    }
  }
  // RJSF seeds empty arrays and strings, which fail `minItems`/`minLength`.
  // Remove minimum constraints from non-identity fields so an identity-only
  // submit validates. enum/format/type checks stay.
  for (const [field, def] of Object.entries(props)) {
    if (identityKeys.has(field) || !isSchemaObject(def)) continue;
    delete def.minItems;
    delete def.minLength;
    delete def.minimum;
  }
  return clone;
}

/**
 * Builds the form's uiSchema: default widgets and field order, then the
 * caller's entries on top.
 *
 * Array fields use checkboxes (enum items) or a comma-separated input, array
 * and boolean fields span full width, and required fields come first. When
 * the schema declares `x-form-layout` sections, their field order wins.
 *
 * @param schema - The link's profile schema.
 * @param uiSchema - The link's uiSchema; its entries override the defaults.
 * @returns The merged uiSchema.
 */
export function buildFormUiSchema(
  schema: RJSFSchema,
  uiSchema: Record<string, unknown>,
): Record<string, unknown> {
  const defs = schema.$defs ?? {};
  /** Whether array items carry an enum, directly or through `$defs`. */
  const hasItemEnum = (items: SchemaNode | undefined) => {
    if (!isSchemaObject(items)) return false;
    if (Array.isArray(items.enum)) return items.enum.length > 0;
    if (items.$ref?.startsWith(DEFS_REF_PREFIX)) {
      const target = defs[items.$ref.slice(DEFS_REF_PREFIX.length)];
      return isSchemaObject(target) && Array.isArray(target.enum) && target.enum.length > 0;
    }
    return false;
  };
  const required = new Set((schema.required ?? []).filter((r) => r !== 'participant_id'));
  const defaults: Record<string, unknown> = {};
  const order: string[] = [];
  const tail: string[] = [];
  for (const [field, def] of Object.entries(schema.properties ?? {})) {
    if (field === 'participant_id') continue;
    const type = isSchemaObject(def) ? def.type : undefined;
    if (type === 'array') {
      if (hasItemEnum(isSchemaObject(def) ? def.items : undefined)) {
        // Enum arrays use checkboxes so only allowed values can be picked.
        defaults[field] = {
          'ui:widget': 'checkboxes',
          'ui:colSpan': 2,
          items: { 'ui:label': false },
        };
      } else {
        defaults[field] = {
          'ui:widget': 'CommaSeparatedArrayWidget',
          'ui:colSpan': 2,
          'ui:options': { itemLabel: 'entry' },
          items: { 'ui:label': false },
        };
      }
      // Full-width fields go last.
      tail.push(field);
    } else if (type === 'boolean') {
      defaults[field] = { 'ui:colSpan': 2 };
      tail.push(field);
    } else if (required.has(field)) {
      order.push(field);
    } else {
      tail.push(field);
    }

    // Schema markers override the type-based widget above.
    const marker = isRecord(def) ? resolveMarkerUiSchema(def, type) : null;
    if (marker) defaults[field] = marker;
  }
  const layout = FormLayoutOrderSchema.safeParse(schema['x-form-layout']);
  const layoutOrder = layout.success
    ? (layout.data.sections ?? []).flatMap((section) => section.fields ?? [])
    : [];

  return {
    'ui:order': layoutOrder.length > 0 ? [...layoutOrder, '*'] : [...order, ...tail, '*'],
    ...defaults,
    ...uiSchema,
    participant_id: { 'ui:widget': 'hidden' },
  };
}
