/**
 * Derives an RJSF `uiSchema` from the `x-` annotations carried by a form schema.
 *
 * Presentation used to live in a sibling `*.v1.ui.json`. It now sits inside the
 * schema itself, the way signals already ships its network item schemas
 * (`x-form-layout`, `x-show-if`) — one document per form, so validation and
 * layout are versioned together and a mounted schemas tree carries both.
 *
 * `x-` keys are annotations: JSON Schema ignores unknown keywords, so Ajv still
 * validates the same document the browser renders. Nothing is stripped before
 * validation, and `additionalProperties: false` is unaffected — that constrains
 * instance data, not schema keywords.
 *
 * Two namespaces, mirroring how signals splits them:
 *   - `x-form-layout` — how a node arranges its children (`order`, `layout`,
 *     `sections`, `twoColumn`)
 *   - `x-ui` — how a single field presents itself (`placeholder`, `widget`,
 *     `enumNames`, `title`, `options`, `autofocus`)
 *
 * @module apps/web/src/lib/form-layout
 */

/** A JSON-Schema-shaped node this module knows how to walk. */
interface SchemaNode {
  properties?: Record<string, SchemaNode> | undefined;
  items?: SchemaNode | undefined;
  'x-form-layout'?: Record<string, unknown> | undefined;
  'x-ui'?: Record<string, unknown> | undefined;
}

/**
 * Builds the `uiSchema` RJSF expects from a schema's `x-` annotations.
 *
 * Recurses through `properties` and `items` so nested objects and array items
 * keep the layout they had when this lived in a separate file. A node with no
 * annotations contributes no key, which matters: RJSF treats an empty object
 * as a directive-bearing node.
 *
 * @param schema - Form schema carrying `x-form-layout` / `x-ui` annotations.
 * @returns The RJSF uiSchema. Empty when the schema carries no annotations.
 */
export function deriveUiSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object') return {};
  const node = schema as SchemaNode;
  const ui: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node['x-form-layout'] ?? {})) {
    ui[`ui:${key}`] = value;
  }
  for (const [key, value] of Object.entries(node['x-ui'] ?? {})) {
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
