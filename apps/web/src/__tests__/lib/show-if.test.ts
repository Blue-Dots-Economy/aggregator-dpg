import { describe, it, expect, vi } from 'vitest';
import type { RJSFSchema } from '@rjsf/utils';
import { isFieldVisible, resolveVisibleSchema, stripShowIf } from '../../lib/show-if';

// A small schema mirroring a real conditional chain:
// educationCategory -> schoolQualification -> schoolQualificationOther
function chainSchema(): RJSFSchema {
  return {
    type: 'object',
    required: ['educationCategory'],
    properties: {
      educationCategory: { type: 'string', enum: ['School', 'College', 'None'] },
      schoolQualification: {
        type: 'string',
        enum: ['10th', '12th', 'Other'],
        'x-show-if': { educationCategory: ['School'] },
      },
      schoolQualificationOther: {
        type: 'string',
        'x-show-if': { schoolQualification: ['Other'] },
      },
      note: { type: 'string' },
    },
  } as RJSFSchema;
}

describe('isFieldVisible', () => {
  it('is always visible when there is no x-show-if', () => {
    expect(isFieldVisible({ type: 'string' }, {})).toBe(true);
  });

  it('matches a scalar control value in the allowed list', () => {
    const field = { 'x-show-if': { educationCategory: ['School'] } };
    expect(isFieldVisible(field, { educationCategory: 'School' })).toBe(true);
    expect(isFieldVisible(field, { educationCategory: 'College' })).toBe(false);
  });

  it('treats a missing/empty control value as no match', () => {
    const field = { 'x-show-if': { educationCategory: ['School'] } };
    expect(isFieldVisible(field, {})).toBe(false);
    expect(isFieldVisible(field, { educationCategory: '' })).toBe(false);
  });

  it('matches when a multi-select control intersects the allowed list', () => {
    const field = { 'x-show-if': { skills: ['welding'] } };
    expect(isFieldVisible(field, { skills: ['welding', 'plumbing'] })).toBe(true);
    expect(isFieldVisible(field, { skills: ['plumbing'] })).toBe(false);
    expect(isFieldVisible(field, { skills: [] })).toBe(false);
  });

  it('ANDs multiple control keys', () => {
    const field = { 'x-show-if': { a: ['x'], b: ['y'] } };
    expect(isFieldVisible(field, { a: 'x', b: 'y' })).toBe(true);
    expect(isFieldVisible(field, { a: 'x', b: 'z' })).toBe(false);
  });
});

describe('resolveVisibleSchema', () => {
  it('keeps all fields visible when controls match (no pruning)', () => {
    const { schema, formData, hidden } = resolveVisibleSchema(chainSchema(), {
      educationCategory: 'School',
      schoolQualification: 'Other',
      schoolQualificationOther: 'Diploma',
    });
    expect(hidden).toEqual([]);
    expect(Object.keys(schema.properties ?? {})).toContain('schoolQualificationOther');
    expect(formData.schoolQualificationOther).toBe('Diploma');
  });

  it('hides a dependent and clears its value when the control does not match', () => {
    const { schema, formData, hidden } = resolveVisibleSchema(chainSchema(), {
      educationCategory: 'College',
      schoolQualification: '10th',
    });
    expect(hidden).toContain('schoolQualification');
    expect(schema.properties).not.toHaveProperty('schoolQualification');
    expect(formData).not.toHaveProperty('schoolQualification');
  });

  it('cascades chains: hiding a control also hides and clears its grandchild', () => {
    const { schema, formData, hidden } = resolveVisibleSchema(chainSchema(), {
      educationCategory: 'College', // hides schoolQualification ...
      schoolQualification: 'Other', // ... which was the control for the grandchild
      schoolQualificationOther: 'Diploma',
    });
    expect(hidden).toEqual(
      expect.arrayContaining(['schoolQualification', 'schoolQualificationOther']),
    );
    expect(formData).not.toHaveProperty('schoolQualificationOther');
    expect(schema.properties).not.toHaveProperty('schoolQualificationOther');
  });

  it('removes hidden fields from required', () => {
    const base = chainSchema();
    base.required = ['educationCategory', 'schoolQualification'];
    const { schema } = resolveVisibleSchema(base, { educationCategory: 'College' });
    expect(schema.required).toEqual(['educationCategory']);
  });

  it('does not mutate the input schema or formData', () => {
    const base = chainSchema();
    const input = { educationCategory: 'College', schoolQualification: '10th' };
    resolveVisibleSchema(base, input);
    expect(input).toHaveProperty('schoolQualification'); // input untouched
    expect(base.properties).toHaveProperty('schoolQualification');
  });

  it('warns in dev when an x-show-if references an unknown control field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: {
        b: { type: 'string', 'x-show-if': { doesNotExist: ['x'] } },
      },
    } as RJSFSchema;
    resolveVisibleSchema(schema, {});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('doesNotExist'));
    warn.mockRestore();
  });
});

describe('stripShowIf', () => {
  it('removes x-show-if everywhere but leaves the rest intact', () => {
    const stripped = stripShowIf(chainSchema());
    const json = JSON.stringify(stripped);
    expect(json).not.toContain('x-show-if');
    // surviving properties and their other keywords remain
    expect(stripped.properties).toHaveProperty('schoolQualification');
    expect(
      (stripped.properties as Record<string, { enum?: unknown[] }>).schoolQualification.enum,
    ).toEqual(['10th', '12th', 'Other']);
  });

  it('returns primitives and arrays unchanged in shape', () => {
    expect(stripShowIf('x')).toBe('x');
    expect(stripShowIf(null)).toBe(null);
    expect(stripShowIf([{ 'x-show-if': { a: ['b'] }, type: 'string' }])).toEqual([
      { type: 'string' },
    ]);
  });
});

// ─── The UP-GZB org-registration SHAPE ──────────────────────────────────────
// Reproduces the arrangement that makes this resolver load-bearing: two
// sub-type fields carrying the SAME title ("Organisation Sub-Type", as the
// sheet does), mutually exclusive via `x-show-if`. Safe only because they are
// never visible at once — which is exactly what these assertions pin down.
//
// Synthetic, not the published document. Since #640 the real forms live in
// `bluedots-schemas`; vendoring a copy here to read would reintroduce the
// second source of truth that change removed, and would rot the first time the
// published form moved. What belongs here is the resolver's behaviour. Whether
// up-gzb's option lists still match the sheet is asserted where the document
// lives.
describe('org-registration mutually exclusive sub-types (up-gzb shape)', () => {
  const schema = {
    type: 'object',
    properties: {
      organisation_type: {
        type: 'string',
        title: 'Organisation Type',
        enum: ['educational', 'non_educational'],
      },
      organisation_sub_type_educational: {
        type: 'string',
        title: 'Organisation Sub-Type',
        enum: ['school', 'polytechnic', 'other'],
        'x-show-if': { organisation_type: ['educational'] },
      },
      organisation_sub_type_non_educational: {
        type: 'string',
        title: 'Organisation Sub-Type',
        enum: ['placement_agency', 'community_group', 'other'],
        'x-show-if': { organisation_type: ['non_educational'] },
      },
    },
  } as RJSFSchema;

  const visible = (formData: Record<string, unknown>): string[] =>
    Object.keys(resolveVisibleSchema(schema, formData).schema.properties ?? {});

  it('hides both sub-types until an organisation type is chosen', () => {
    const props = visible({});
    expect(props).not.toContain('organisation_sub_type_educational');
    expect(props).not.toContain('organisation_sub_type_non_educational');
  });

  it('shows only the educational sub-type for Educational', () => {
    const props = visible({ organisation_type: 'educational' });
    expect(props).toContain('organisation_sub_type_educational');
    expect(props).not.toContain('organisation_sub_type_non_educational');
  });

  it('shows only the non-educational sub-type for Non-Educational', () => {
    const props = visible({ organisation_type: 'non_educational' });
    expect(props).toContain('organisation_sub_type_non_educational');
    expect(props).not.toContain('organisation_sub_type_educational');
  });

  it('clears a stale sub-type when the organisation type flips', () => {
    // Educational answered, then switched to Non-Educational: the now-hidden
    // value must not survive into the submitted payload.
    const { formData } = resolveVisibleSchema(schema, {
      organisation_type: 'non_educational',
      organisation_sub_type_educational: 'polytechnic',
    });
    expect(formData).not.toHaveProperty('organisation_sub_type_educational');
    expect(formData['organisation_type']).toBe('non_educational');
  });
});
