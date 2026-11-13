/**
 * Unit tests for `readableFormErrors` and `serverFieldErrors`: field-named
 * messages, the form-standard "required" / "Invalid entry" sentences with the
 * schema's example, and server errors mapped onto their field.
 */
import { describe, it, expect } from 'vitest';
import type { RJSFValidationError } from '@rjsf/utils';
import {
  messagesToErrorSchema,
  readableFormErrors,
  serverFieldErrors,
  type FieldErrorCopy,
} from '@/lib/readable-form-errors';

const schema = {
  type: 'object',
  properties: {
    contact: {
      type: 'object',
      title: 'Primary Contact',
      properties: {
        phone: {
          type: 'string',
          title: 'Phone',
          pattern: '^\\d{10}$',
          examples: ['9876543210'],
        },
        email: { type: 'string', title: 'Email', format: 'email' },
        name: { type: 'string', title: 'Contact Name', minLength: 2 },
      },
    },
  },
};

const copy: FieldErrorCopy = {
  required: (label) => `${label} is required.`,
  invalid: (message) => `Invalid entry. ${message}`,
};

function err(e: Partial<RJSFValidationError>): RJSFValidationError {
  return { stack: '', ...e };
}

describe('readableFormErrors', () => {
  it('keeps the existing Label: message stack when no copy is given', () => {
    const [out] = readableFormErrors(
      [err({ name: 'pattern', property: '.contact.phone', params: { pattern: '^\\d{10}$' } })],
      schema,
    );
    expect(out!.message).toBe('Please enter a valid Phone.');
    expect(out!.stack).toBe('Phone: Please enter a valid Phone.');
  });

  it('says a missing field is required, without an example', () => {
    const [out] = readableFormErrors(
      [err({ name: 'required', property: '.contact.phone', params: { missingProperty: 'phone' } })],
      schema,
      copy,
    );
    expect(out!.message).toBe('Phone is required.');
    expect(out!.stack).toBe(out!.message);
  });

  it('says a wrong value is an invalid entry, never showing the regex', () => {
    const [out] = readableFormErrors(
      [
        err({
          name: 'pattern',
          property: '.contact.phone',
          message: 'must match pattern "^\\d{10}$"',
        }),
      ],
      schema,
      copy,
    );
    expect(out!.message).toBe('Invalid entry. Please enter a valid Phone.');
    expect(out!.message).not.toContain('^');
  });

  it('names the field for format and length errors; only format errors get the example', () => {
    const out = readableFormErrors(
      [
        err({ name: 'format', property: '.contact.email', message: 'must match format "email"' }),
        err({ name: 'minLength', property: '.contact.name', params: { limit: 2 } }),
      ],
      schema,
      copy,
    );
    expect(out.map((e) => e.message)).toEqual([
      'Invalid entry. Please enter a valid Email.',
      'Invalid entry. Contact Name must be at least 2 characters.',
    ]);
  });
});

describe('readableFormErrors wording', () => {
  it('says an emptied minLength-1 field is required', () => {
    const [out] = readableFormErrors(
      [err({ name: 'minLength', property: '.contact.name', params: { limit: 1 } })],
      schema,
      copy,
    );
    expect(out!.message).toBe('Contact Name is required.');
  });

  it('says an empty minItems-1 pick is required, not the raw rule', () => {
    const [out] = readableFormErrors(
      [err({ name: 'minItems', property: '.contact.name', params: { limit: 1 } })],
      schema,
      copy,
    );
    expect(out!.message).toBe('Contact Name is required.');
  });

  it('words the reason with the translated copy when given', () => {
    const [out] = readableFormErrors(
      [err({ name: 'format', property: '.contact.email', message: 'must match format "email"' })],
      schema,
      { ...copy, validValue: (label) => `VALID:${label}` },
    );
    expect(out!.message).toBe('Invalid entry. VALID:Email.');
  });
});

describe('serverFieldErrors completeness', () => {
  it('does not treat Object members as schema fields', () => {
    const out = serverFieldErrors({ field_errors: { constructor: 'bad' } }, schema, copy);
    expect(out?.lines).toEqual([]);
    expect(out?.complete).toBe(false);
  });

  it('skips malformed issues instead of throwing', () => {
    expect(() =>
      serverFieldErrors({ issues: [{ keyword: 'pattern', instancePath: 5 }, null] }, schema, copy),
    ).not.toThrow();
  });

  it('reports when a message names a field the form does not have', () => {
    const out = serverFieldErrors(
      {
        field_errors: [
          { field: 'contact.phone', label: 'Phone', message: 'Please enter a valid Phone.' },
          { field: 'consent_terms', label: 'Terms', message: 'is required' },
        ],
      },
      schema,
      copy,
    );
    expect(out?.complete).toBe(false);
    expect(out?.errorSchema).toEqual({
      contact: { phone: { __errors: ['Invalid entry. Please enter a valid Phone.'] } },
    });
  });
});

describe('readableFormErrors example rule', () => {
  it('gives no example for a length error, even when the field has one', () => {
    const [out] = readableFormErrors(
      [err({ name: 'maxLength', property: '.contact.phone', params: { limit: 15 } })],
      schema,
      copy,
    );
    expect(out!.message).toBe('Invalid entry. Phone must be at most 15 characters.');
  });
});

describe('serverFieldErrors', () => {
  it('maps raw Ajv issues onto their field', () => {
    const out = serverFieldErrors(
      {
        issues: [
          { keyword: 'required', instancePath: '/contact', params: { missingProperty: 'phone' } },
        ],
      },
      schema,
      copy,
    );
    expect(out?.lines).toEqual(['Phone is required.']);
    expect(out?.errorSchema).toEqual({
      contact: { phone: { __errors: ['Phone is required.'] } },
    });
  });

  it('maps worded field errors onto their field', () => {
    const out = serverFieldErrors(
      {
        field_errors: [
          { field: 'contact.phone', label: 'Phone', message: 'Please enter a valid Phone.' },
        ],
      },
      schema,
      copy,
    );
    expect(out?.errorSchema).toEqual({
      contact: {
        phone: { __errors: ['Invalid entry. Please enter a valid Phone.'] },
      },
    });
  });

  it('returns null when nothing maps to a field', () => {
    expect(serverFieldErrors({ reason: 'RATE_LIMITED' }, schema, copy)).toBeNull();
    expect(serverFieldErrors(undefined, schema, copy)).toBeNull();
    expect(serverFieldErrors({ field_errors: { website: 42 } }, schema, copy)).toBeNull();
  });

  it('maps a { field: message } map, naming the field from the schema', () => {
    const out = serverFieldErrors(
      {
        field_errors: {
          'contact.phone': 'Please enter a valid Phone',
          'contact.name': 'is required',
        },
      },
      schema,
      copy,
    );
    expect(out?.errorSchema).toEqual({
      contact: {
        phone: { __errors: ['Invalid entry. Please enter a valid Phone.'] },
        name: { __errors: ['Contact Name is required.'] },
      },
    });
  });

  it('skips a field_errors map that repeats fields already named by issues', () => {
    const out = serverFieldErrors(
      {
        issues: [
          { keyword: 'required', instancePath: '/contact', params: { missingProperty: 'phone' } },
        ],
        field_errors: { 'contact.phone': 'is required' },
      },
      schema,
      copy,
    );
    expect(out?.lines).toEqual(['Phone is required.']);
  });

  it('never writes through __proto__ and maps no Object members', () => {
    const fromServer = JSON.parse(
      '{"__proto__.polluted":"x","constructor.prototype":"y","toString":"z"}',
    ) as Record<string, unknown>;
    // None of these are schema fields, so nothing maps (the caller shows a banner).
    const out = serverFieldErrors({ field_errors: fromServer }, schema, copy);
    expect(out?.lines).toEqual([]);
    expect(out?.complete).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['__errors']).toBeUndefined();
  });
});

describe('serverFieldErrors flat fields', () => {
  it('marks a field the API names flatly, without showing the value it sent', () => {
    const out = serverFieldErrors(
      { 'contact.phone': '+9112345', sub_operation: 'x' },
      schema,
      copy,
    );
    expect(out?.complete).toBe(true);
    expect(JSON.stringify(out?.errorSchema)).not.toContain('+9112345');
    expect(out?.lines[0]).toMatch(/^Invalid entry\./);
  });

  it('keeps the message issues worded when field_errors names the same field', () => {
    const out = serverFieldErrors(
      {
        issues: [{ keyword: 'minLength', instancePath: '/contact/name', params: { limit: 2 } }],
        field_errors: { 'contact.name': 'Signals wording' },
      },
      schema,
      copy,
    );
    expect(out?.lines).toHaveLength(1);
    expect(out?.lines[0]).not.toContain('Signals wording');
  });

  it('returns the messages no field on the form owns', () => {
    const out = serverFieldErrors({ field_errors: { consent_terms: 'is required' } }, schema, copy);
    expect(out?.unmapped).toHaveLength(1);
  });
});

describe('messagesToErrorSchema', () => {
  it('nests dotted paths and collects messages per field', () => {
    expect(messagesToErrorSchema({ website: 'bad', 'address.city': 'is required' })).toEqual({
      website: { __errors: ['bad'] },
      address: { city: { __errors: ['is required'] } },
    });
  });

  it('refuses __proto__ paths and walks only own properties', () => {
    const out = messagesToErrorSchema(
      JSON.parse('{"__proto__.polluted":"x","constructor.prototype":"y"}') as Record<
        string,
        string
      >,
    )!;
    expect(out).toEqual({ constructor: { prototype: { __errors: ['y'] } } });
    expect(({} as Record<string, unknown>)['__errors']).toBeUndefined();
  });

  it('returns null when there is nothing to mark', () => {
    expect(messagesToErrorSchema({})).toBeNull();
    expect(messagesToErrorSchema({ '': 'x' })).toBeNull();
  });
});
