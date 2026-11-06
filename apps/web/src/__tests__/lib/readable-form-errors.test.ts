import { describe, it, expect } from 'vitest';
import type { RJSFValidationError } from '@rjsf/utils';
import { readableFormErrors } from '@/lib/readable-form-errors';

const schema = {
  type: 'object',
  properties: {
    address: {
      type: 'object',
      title: 'Address',
      properties: { city: { type: 'string', title: 'City' } },
    },
    url: { type: 'string', title: 'Website' },
  },
};

describe('readableFormErrors', () => {
  it('names a missing field once, by its title, when RJSF already ends the path with it', () => {
    const [out] = readableFormErrors(
      [
        {
          name: 'required',
          property: '.address.city',
          params: { missingProperty: 'city' },
          message: "must have required property 'city'",
          stack: '',
        },
      ],
      schema,
    );
    expect(out?.message).toBe('is required');
    expect(out?.stack).toBe('City: is required.');
  });

  it('names an extra field once when RJSF already ends the path with it', () => {
    const [out] = readableFormErrors(
      [
        {
          name: 'additionalProperties',
          property: '.extra',
          params: { additionalProperty: 'extra' },
          stack: '',
        },
      ],
      schema,
    );
    expect(out?.message).toBe('is not an allowed field');
    expect(out?.stack).toBe('extra: is not an allowed field.');
  });

  it('reads an error without params or property', () => {
    const error: RJSFValidationError = { name: 'type', message: 'must be string', stack: '' };
    const [out] = readableFormErrors([error], schema);
    expect(out?.name).toBe('type');
    expect(typeof out?.message).toBe('string');
  });
});
