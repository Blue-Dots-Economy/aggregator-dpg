/**
 * `deriveUiSchema` — rebuilding the RJSF uiSchema from a schema's x- annotations.
 *
 * These replace what a sibling `*.v1.ui.json` used to assert. The interesting
 * cases are the ones a naive implementation gets wrong: nesting, array items,
 * and nodes that must contribute NO key at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { deriveUiSchema } from '@/lib/form-layout';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('deriveUiSchema', () => {
  it('maps x-rjsf and x-rjsf onto ui: directives', () => {
    expect(
      deriveUiSchema({
        'x-rjsf': { order: ['a'], layout: 'stack' },
        properties: { a: { 'x-rjsf': { placeholder: 'A', widget: 'select' } } },
      }),
    ).toEqual({
      'ui:order': ['a'],
      'ui:layout': 'stack',
      a: { 'ui:placeholder': 'A', 'ui:widget': 'select' },
    });
  });

  it('recurses through array items', () => {
    expect(
      deriveUiSchema({
        properties: {
          locations: {
            'x-rjsf': { options: { addable: true } },
            items: { properties: { geo: { 'x-rjsf': { widget: 'hidden' } } } },
          },
        },
      }),
    ).toEqual({
      locations: {
        'ui:options': { addable: true },
        items: { geo: { 'ui:widget': 'hidden' } },
      },
    });
  });

  it('omits nodes with no annotations rather than emitting {}', () => {
    // RJSF treats a present-but-empty object as a directive-bearing node, so an
    // unannotated field must contribute no key at all.
    const ui = deriveUiSchema({ properties: { plain: { type: 'string' } } });
    expect(ui).toEqual({});
    expect(Object.hasOwn(ui, 'plain')).toBe(false);
  });

  it('returns {} for a non-object, rather than throwing', () => {
    expect(deriveUiSchema(null)).toEqual({});
    expect(deriveUiSchema('nope')).toEqual({});
  });

  it('reproduces the real coordinator-registration layout from the published bundle', () => {
    // Guards the actual conversion against the document users are served, not
    // a hand-written fixture: if the merge dropped a directive, the real form
    // loses it silently. Reads the vendored copy of the published bundle —
    // #640 removed the on-disk schema this used to open.
    const path = resolve(__dirname, '../__fixtures__/aggregator-forms.blue_dot.json');
    const bundle = JSON.parse(readFileSync(path, 'utf8')) as {
      forms: Record<string, Record<string, unknown>>;
    };
    const schema = bundle.forms['coordinator-registration']!;
    const ui = deriveUiSchema(schema);

    expect(ui['ui:order']).toEqual(['name', 'type', 'url', 'contact', 'locations', 'consent']);
    expect(ui['name']).toMatchObject({ 'ui:autofocus': true });
    expect(ui['type']).toMatchObject({ 'ui:widget': 'select' });
    // Nested array-item layout survived the merge.
    expect((ui['locations'] as Record<string, unknown>)['items']).toBeDefined();
  });
});
