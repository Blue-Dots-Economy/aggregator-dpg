/**
 * `deriveUiSchema` — rebuilding the RJSF uiSchema from a schema's x- annotations.
 *
 * These replace what a sibling `*.v1.ui.json` used to assert. The interesting
 * cases are the ones a naive implementation gets wrong: nesting, array items,
 * and nodes that must contribute NO key at all.
 */
import { describe, it, expect } from 'vitest';
import { deriveUiSchema } from '@/lib/form-layout';

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

  it('derives every directive kind from one nested schema', () => {
    // Stands in for the shipped form this used to read. Since #640 the real
    // documents live in `bluedots-schemas`, and keeping a copy here to assert
    // against would reintroduce the second source of truth that change removed.
    // What belongs in this repo is the converter; whether a published form
    // still carries a given directive is asserted where the form lives.
    const schema = {
      type: 'object',
      'x-rjsf': { order: ['name', 'type', 'contact', 'locations'] },
      properties: {
        name: { type: 'string', 'x-rjsf': { autofocus: true, placeholder: 'Your name' } },
        type: {
          type: 'string',
          'x-rjsf': { widget: 'select', enumNames: ['Seeker', 'Provider'] },
        },
        contact: {
          type: 'object',
          'x-rjsf': { order: ['phone'] },
          properties: { phone: { type: 'string', 'x-rjsf': { placeholder: '+91…' } } },
        },
        locations: {
          type: 'array',
          items: {
            type: 'object',
            properties: { geo: { type: 'object', 'x-rjsf': { widget: 'hidden' } } },
          },
        },
      },
    };

    const ui = deriveUiSchema(schema);

    expect(ui['ui:order']).toEqual(['name', 'type', 'contact', 'locations']);
    expect(ui['name']).toEqual({ 'ui:autofocus': true, 'ui:placeholder': 'Your name' });
    expect(ui['type']).toEqual({
      'ui:widget': 'select',
      'ui:enumNames': ['Seeker', 'Provider'],
    });
    // Nested objects recurse, keeping their own order.
    expect(ui['contact']).toEqual({
      'ui:order': ['phone'],
      phone: { 'ui:placeholder': '+91…' },
    });
    // Array-item layout survives, which is where the registration form's
    // location repeater lives.
    expect((ui['locations'] as Record<string, unknown>)['items']).toEqual({
      geo: { 'ui:widget': 'hidden' },
    });
  });
});
