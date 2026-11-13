import { describe, it, expect } from 'vitest';
import {
  adviceForMissingContact,
  adviceForPhone,
  adviceForRejection,
  adviceForSchemaIssue,
  isPhoneColumn,
  joinAdvice,
} from './bulk-fix-advice.js';

const schema = {
  type: 'object',
  properties: {
    phone: { type: 'string' },
    gender: { type: 'string', enum: ['Male', 'Female'] },
    languageSpoken: { type: 'array', items: { type: 'string', enum: ['Hindi', 'Kannada'] } },
    age: { type: 'integer', minimum: 14 },
  },
};

describe('adviceForSchemaIssue', () => {
  it('asks for a 10-digit number when a phone column fails its pattern', () => {
    expect(adviceForSchemaIssue({ keyword: 'pattern' }, 'phone', schema, '|')).toBe(
      'Check the format of the phone number in the "phone" column. It should be a 10-digit mobile number, or + and the country code followed by the number.',
    );
  });

  it('points at the Allowed values sheet, and the separator for a list column', () => {
    expect(adviceForSchemaIssue({ keyword: 'enum' }, 'gender', schema, '|')).toBe(
      'Check the value in the "gender" column. Use only the values in the "Allowed values" sheet of the downloadable template.',
    );
    expect(adviceForSchemaIssue({ keyword: 'enum' }, 'languageSpoken', schema, '|')).toContain(
      'separate more than one value with | and no spaces',
    );
  });

  it('asks to fill a required column and names the limit for a range', () => {
    expect(
      adviceForSchemaIssue(
        { keyword: 'required', params: { missingProperty: 'phone' } },
        'phone',
        schema,
        '|',
      ),
    ).toBe('Fill in the "phone" column. It cannot be left blank for this row.');
    expect(
      adviceForSchemaIssue({ keyword: 'minimum', params: { limit: 14 } }, 'age', schema, '|'),
    ).toBe('Check the "age" column. It should be at least 14.');
  });
});

describe('adviceForRejection', () => {
  it('says no action is needed for a person owned by another aggregator', () => {
    expect(adviceForRejection('owned_elsewhere', undefined, undefined)[0]).toMatch(
      /^No action needed\./,
    );
  });

  it('uses the Signals code when there is one', () => {
    expect(adviceForRejection('validation', 'U18_NOT_ALLOWED', undefined)[0]).toMatch(/under 18/);
  });

  it('points at the rejected columns, with phone advice for a phone column', () => {
    expect(
      adviceForRejection('validation', 'INVALID_ITEM_STATE', { phone: 'bad', gender: 'bad' }),
    ).toEqual([
      adviceForPhone('phone'),
      'Check the value in the "gender" column against the downloadable template.',
    ]);
  });

  it('warns against re-uploading after a platform fault, which could duplicate the person', () => {
    const [advice] = adviceForRejection('system_error', undefined, undefined);
    expect(advice).toMatch(/not in the row/);
    expect(advice).toMatch(/Do not upload it again yet/);
  });

  it('gives older records without stored advice a fitting default', () => {
    expect(adviceForRejection('duplicate', undefined, undefined)[0]).toMatch(/typing mistakes/);
    expect(adviceForRejection('normalisation', undefined, undefined)[0]).toMatch(/phone number/);
  });

  it('ignores Signals codes that are Object members', () => {
    expect(adviceForRejection('validation', 'constructor', undefined)[0]).not.toMatch(/function/);
  });
});

describe('adviceForSchemaIssue wording', () => {
  it('gives phone advice only to real phone columns', () => {
    expect(isPhoneColumn('contact_phone')).toBe(true);
    expect(isPhoneColumn('mobileNumber')).toBe(true);
    expect(isPhoneColumn('mobile_app_url')).toBe(false);
    expect(isPhoneColumn('has_smartphone')).toBe(false);
    expect(adviceForSchemaIssue({ keyword: 'pattern' }, 'mobile_app_url', schema, '|')).toBe(
      'Check the format of the value in the "mobile_app_url" column.',
    );
  });

  it('says "fill in" for a one-character minimum and names types readably', () => {
    expect(
      adviceForSchemaIssue({ keyword: 'minLength', params: { limit: 1 } }, 'name', schema, '|'),
    ).toMatch(/^Fill in the "name" column/);
    expect(
      adviceForSchemaIssue({ keyword: 'type', params: { type: 'integer' } }, 'age', schema, '|'),
    ).toBe('Check the "age" column. It should be a whole number.');
    expect(
      adviceForSchemaIssue(
        { keyword: 'type', params: { type: ['string', 'null'] } },
        'name',
        schema,
        '|',
      ),
    ).toBe('Check the "name" column. It should be a text.');
  });

  it('asks to remove a column the template does not have', () => {
    expect(adviceForSchemaIssue({ keyword: 'additionalProperties' }, 'foo', schema, '|')).toBe(
      'Remove the "foo" column; it is not part of the template.',
    );
  });
});

describe('joinAdvice', () => {
  it('drops repeated lines', () => {
    expect(joinAdvice(['A.', 'B.', 'A.'])).toBe('A. B.');
  });
});

describe('adviceForMissingContact', () => {
  it('names the phone column, and the email column when the domain has one', () => {
    expect(adviceForMissingContact('phone')).toBe(
      'Fill in the "phone" column. It cannot be left blank for this row.',
    );
    expect(adviceForMissingContact('phone', 'email')).toBe(
      'Fill in the "phone" or "email" column. Each row needs at least one of them.',
    );
  });
});
