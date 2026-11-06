import { describe, it, expect } from 'vitest';
import type { RJSFSchema } from '@rjsf/utils';
import {
  buildFormSchema,
  buildFormUiSchema,
  resolveMarkerUiSchema,
} from '@/app/[org]/[slug]/_lib/form-schema';

const IDENTITY = { name: 'name', phone: 'phone', email: 'email' };

/** A schema that exercises every transform. */
function sampleSchema(): RJSFSchema {
  return {
    title: 'Profile',
    description: 'Long description',
    type: 'object',
    required: ['participant_id', 'name', 'phone', 'skills', 'bio'],
    $defs: { skill: { type: 'string', enum: ['a', 'b'] } },
    properties: {
      participant_id: { type: 'string' },
      name: { type: 'string', minLength: 2 },
      phone: { type: 'string', minLength: 10 },
      bio: { type: 'string', minLength: 5 },
      age: { type: 'integer', minimum: 18 },
      skills: { type: 'array', minItems: 1, items: { $ref: '#/$defs/skill', title: 'Skill' } },
      langs: { type: 'array', items: { type: 'string', enum: ['en', 'hi'] } },
      tags: { type: 'array', items: { type: 'string' } },
      missing_ref: { type: 'array', items: { $ref: '#/$defs/nope' } },
      tuple: { type: 'array', items: [{ type: 'string' }] },
      agreed: { type: 'boolean' },
      anything: true,
    },
  };
}

describe('buildFormSchema', () => {
  it('drops the title, description and participant_id', () => {
    const out = buildFormSchema(sampleSchema(), IDENTITY);
    expect(out).not.toHaveProperty('title');
    expect(out).not.toHaveProperty('description');
    expect(out.properties).not.toHaveProperty('participant_id');
  });

  it('keeps only identity fields required', () => {
    expect(buildFormSchema(sampleSchema(), IDENTITY).required).toEqual(['name', 'phone']);
  });

  it('drops every required field when no identity is given', () => {
    expect(buildFormSchema(sampleSchema(), undefined).required).toEqual([]);
  });

  it('leaves a schema without `required` without it', () => {
    const { required: _r, ...rest } = sampleSchema();
    expect(buildFormSchema(rest, IDENTITY)).not.toHaveProperty('required');
  });

  it('inlines an items $ref into $defs and marks the array uniqueItems', () => {
    const skills = buildFormSchema(sampleSchema(), IDENTITY).properties?.['skills'];
    expect(skills).toEqual({
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: ['a', 'b'], title: 'Skill' },
    });
  });

  it('marks a direct enum array uniqueItems', () => {
    expect(buildFormSchema(sampleSchema(), IDENTITY).properties?.['langs']).toMatchObject({
      uniqueItems: true,
    });
  });

  it('leaves free-text, tuple and unresolved-ref arrays alone', () => {
    const props = buildFormSchema(sampleSchema(), IDENTITY).properties;
    expect(props?.['tags']).toEqual({ type: 'array', items: { type: 'string' } });
    expect(props?.['missing_ref']).toEqual({ type: 'array', items: { $ref: '#/$defs/nope' } });
    expect(props?.['tuple']).toEqual({ type: 'array', items: [{ type: 'string' }] });
  });

  it('removes minimum constraints from non-identity fields only', () => {
    const props = buildFormSchema(sampleSchema(), IDENTITY).properties;
    expect(props?.['name']).toEqual({ type: 'string', minLength: 2 });
    expect(props?.['phone']).toEqual({ type: 'string', minLength: 10 });
    expect(props?.['bio']).toEqual({ type: 'string' });
    expect(props?.['age']).toEqual({ type: 'integer' });
    expect(props?.['anything']).toBe(true);
  });

  it('does not change the input schema', () => {
    const input = sampleSchema();
    const before = structuredClone(input);
    buildFormSchema(input, IDENTITY);
    expect(input).toEqual(before);
  });

  it('accepts a schema without properties', () => {
    expect(buildFormSchema({ type: 'object', title: 'x' }, IDENTITY)).toEqual({ type: 'object' });
  });
});

describe('buildFormUiSchema', () => {
  it('puts required fields first, full-width fields last, then the wildcard', () => {
    const ui = buildFormUiSchema(sampleSchema(), {});
    expect(ui['ui:order']).toEqual([
      'name',
      'phone',
      'bio',
      'age',
      'skills',
      'langs',
      'tags',
      'missing_ref',
      'tuple',
      'agreed',
      'anything',
      '*',
    ]);
  });

  it('uses checkboxes for enum arrays, direct or through $defs', () => {
    const ui = buildFormUiSchema(sampleSchema(), {});
    const checkboxes = { 'ui:widget': 'checkboxes', 'ui:colSpan': 2, items: { 'ui:label': false } };
    expect(ui['skills']).toEqual(checkboxes);
    expect(ui['langs']).toEqual(checkboxes);
  });

  it('uses the comma-separated input for other arrays', () => {
    const ui = buildFormUiSchema(sampleSchema(), {});
    const comma = {
      'ui:widget': 'CommaSeparatedArrayWidget',
      'ui:colSpan': 2,
      'ui:options': { itemLabel: 'entry' },
      items: { 'ui:label': false },
    };
    expect(ui['tags']).toEqual(comma);
    expect(ui['missing_ref']).toEqual(comma);
    expect(ui['tuple']).toEqual(comma);
  });

  it('spans boolean fields across both columns', () => {
    expect(buildFormUiSchema(sampleSchema(), {})['agreed']).toEqual({ 'ui:colSpan': 2 });
  });

  it('hides participant_id and lets caller entries override defaults', () => {
    const ui = buildFormUiSchema(sampleSchema(), {
      tags: { 'ui:widget': 'textarea' },
      participant_id: { 'ui:widget': 'text' },
    });
    expect(ui['tags']).toEqual({ 'ui:widget': 'textarea' });
    expect(ui['participant_id']).toEqual({ 'ui:widget': 'hidden' });
  });

  it('follows x-form-layout sections when present', () => {
    const schema: RJSFSchema = {
      ...sampleSchema(),
      'x-form-layout': { sections: [{ fields: ['bio', 'name'] }, {}, { fields: ['agreed'] }] },
    };
    expect(buildFormUiSchema(schema, {})['ui:order']).toEqual(['bio', 'name', 'agreed', '*']);
  });

  it('lets a schema marker replace the type-based widget', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        home: { type: 'array', location: 'primary', items: { type: 'string' } },
        college: { type: 'string', 'x-reference-source': 'colleges' },
      },
    };
    const ui = buildFormUiSchema(schema, {});
    expect(ui['home']).toMatchObject({ 'ui:widget': 'location-multi' });
    expect(ui['college']).toEqual({
      'ui:widget': 'reference-autocomplete',
      'ui:options': { source: 'colleges' },
    });
  });

  it('returns only the order and participant_id entry for a schema without properties', () => {
    expect(buildFormUiSchema({ type: 'object' }, {})).toEqual({
      'ui:order': ['*'],
      participant_id: { 'ui:widget': 'hidden' },
    });
  });
});

describe('resolveMarkerUiSchema — reference source', () => {
  it('reads an object marker with string subtitle fields', () => {
    expect(
      resolveMarkerUiSchema(
        { 'x-reference-source': { source: 'colleges', subtitle: ['city', 3, 'state'] } },
        'string',
      ),
    ).toEqual({
      'ui:widget': 'reference-autocomplete',
      'ui:options': { source: 'colleges', subtitleFields: ['city', 'state'] },
    });
  });

  it('ignores an object marker without a string source', () => {
    expect(resolveMarkerUiSchema({ 'x-reference-source': { source: 4 } }, 'string')).toBeNull();
  });

  it('returns null when no marker applies', () => {
    expect(resolveMarkerUiSchema({ location: 'other' }, 'string')).toBeNull();
  });
});
