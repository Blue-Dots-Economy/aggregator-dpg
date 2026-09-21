/**
 * `deriveUiSchema` — rebuilding the RJSF uiSchema from a schema's x- annotations.
 *
 * These replace what a sibling `*.v1.ui.json` used to assert. The interesting
 * cases are the ones a naive implementation gets wrong: nesting, array items,
 * and nodes that must contribute NO key at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveUiSchema } from '@/lib/form-layout';

describe('deriveUiSchema', () => {
  it('maps x-form-layout and x-ui onto ui: directives', () => {
    expect(
      deriveUiSchema({
        'x-form-layout': { order: ['a'], layout: 'stack' },
        properties: { a: { 'x-ui': { placeholder: 'A', widget: 'select' } } },
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
            'x-ui': { options: { addable: true } },
            items: { properties: { geo: { 'x-ui': { widget: 'hidden' } } } },
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

  it('reproduces the real registration.v1 layout from the shipped schema', () => {
    // Guards the actual conversion, not a fixture: if the merge dropped
    // something, the shipped form loses it silently.
    const path = resolve(process.cwd(), '../../config/schemas/aggregator/registration.v1.json');
    const schema = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const ui = deriveUiSchema(schema);

    expect(ui['ui:order']).toEqual(['name', 'type', 'url', 'contact', 'locations', 'consent']);
    expect(ui['name']).toMatchObject({ 'ui:autofocus': true });
    expect(ui['type']).toMatchObject({ 'ui:widget': 'select' });
    // Nested array-item layout survived the merge.
    expect((ui['locations'] as Record<string, unknown>)['items']).toBeDefined();
  });
});
