/**
 * Derives an RJSF `uiSchema` from the `x-rjsf` annotations on a form schema.
 *
 * Presentation used to live in a sibling `*.v1.ui.json`. It now sits inside the
 * schema itself — one document per form, so validation and layout are versioned
 * together and a mounted schemas tree carries both.
 *
 * Deliberately NOT `x-form-layout`: that key is already implemented by
 * `RjsfThemed` with signals' `{ sections, twoColumn }` vocabulary, and a schema
 * that sets it switches to sectioned rendering. Reusing it for RJSF directives
 * would put two vocabularies behind one name. `x-form-layout` stays free for
 * any form that genuinely wants sections; `x-rjsf` is aggregator-only and says
 * so.
 *
 * `x-` keys are annotations: JSON Schema ignores unknown keywords, so Ajv still
 * validates the same document the browser renders. Nothing is stripped before
 * validation, and `additionalProperties: false` is unaffected — that constrains
 * instance data, not schema keywords.
 *
 * One namespace, `x-rjsf`, holding every directive RJSF understands for that
 * node: `order`, `layout`, `placeholder`, `widget`, `enumNames`, `title`,
 * `options`, `autofocus`.
 *
 * @module apps/web/src/lib/form-layout
 */

/** A JSON-Schema-shaped node this module knows how to walk. */
interface SchemaNode {
  properties?: Record<string, SchemaNode> | undefined;
  items?: SchemaNode | undefined;
  'x-rjsf'?: Record<string, unknown> | undefined;
}

/**
 * Builds the `uiSchema` RJSF expects from a schema's `x-` annotations.
 *
 * Recurses through `properties` and `items` so nested objects and array items
 * keep the layout they had when this lived in a separate file. A node with no
 * annotations contributes no key, which matters: RJSF treats an empty object
 * as a directive-bearing node.
 *
 * @param schema - Form schema carrying `x-rjsf` annotations.
 * @returns The RJSF uiSchema. Empty when the schema carries no annotations.
 */
export function deriveUiSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object') return {};
  const node = schema as SchemaNode;
  const ui: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node['x-rjsf'] ?? {})) {
    ui[`ui:${key}`] = value;
  }

  for (const [name, child] of Object.entries(node.properties ?? {})) {
    const childUi = deriveUiSchema(child);
    if (Object.keys(childUi).length > 0) ui[name] = childUi;
  }

  if (node.items && typeof node.items === 'object') {
    const itemsUi = deriveUiSchema(node.items);
    if (Object.keys(itemsUi).length > 0) ui['items'] = itemsUi;
  }

  return ui;
}
