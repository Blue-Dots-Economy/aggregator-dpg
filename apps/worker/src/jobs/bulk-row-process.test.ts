/**
 * Unit tests for the pure, behaviour-changing helpers in the bulk row
 * processor: empty-cell stripping and the required-error pass-through filter.
 *
 * These two functions decide which bulk rows fail vs. pass through to signals
 * as `draft`, so a regression here would silently ship malformed or
 * unintended-partial data upstream — hence direct coverage.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect } from 'vitest';
import {
  stripAllEmptyCells,
  blockingValidationReasons,
  type SchemaValidationError,
} from './bulk-row-process.js';

describe('stripAllEmptyCells', () => {
  it('removes empty strings (including whitespace-only)', () => {
    const payload: Record<string, unknown> = { name: 'Asha', bio: '', city: '   ' };
    stripAllEmptyCells(payload);
    expect(payload).toEqual({ name: 'Asha' });
  });

  it('removes null and undefined cells', () => {
    const payload: Record<string, unknown> = { a: null, b: undefined, c: 'keep' };
    stripAllEmptyCells(payload);
    expect(payload).toEqual({ c: 'keep' });
  });

  it('removes empty arrays but keeps non-empty ones', () => {
    const payload: Record<string, unknown> = { tags: [], skills: ['welding'] };
    stripAllEmptyCells(payload);
    expect(payload).toEqual({ skills: ['welding'] });
  });

  it('keeps falsy-but-populated values (0, false)', () => {
    const payload: Record<string, unknown> = { count: 0, active: false, note: '' };
    stripAllEmptyCells(payload);
    expect(payload).toEqual({ count: 0, active: false });
  });

  it('is a no-op on an already-clean payload', () => {
    const payload: Record<string, unknown> = { name: 'Asha', age: 30 };
    stripAllEmptyCells(payload);
    expect(payload).toEqual({ name: 'Asha', age: 30 });
  });
});

describe('blockingValidationReasons', () => {
  const required: SchemaValidationError = {
    keyword: 'required',
    schemaPath: '#/required',
    message: "must have required property 'name'",
  };
  const typeErr: SchemaValidationError = {
    keyword: 'type',
    instancePath: '/age',
    message: 'must be number',
  };
  const enumErr: SchemaValidationError = {
    keyword: 'enum',
    instancePath: '/status',
    message: 'must be equal to one of the allowed values',
  };

  it('returns empty when the only errors are missing-required (partial → draft)', () => {
    expect(blockingValidationReasons([required])).toEqual([]);
  });

  it('returns empty for no errors', () => {
    expect(blockingValidationReasons([])).toEqual([]);
  });

  it('surfaces a type error as a blocking reason', () => {
    const reasons = blockingValidationReasons([typeErr]);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('/age');
    expect(reasons[0]).toContain('must be number');
  });

  it('keeps only the non-required errors when required + content errors are mixed', () => {
    const reasons = blockingValidationReasons([required, typeErr, enumErr]);
    expect(reasons).toHaveLength(2);
    expect(reasons.join(' ')).toContain('/age');
    expect(reasons.join(' ')).toContain('/status');
    expect(reasons.join(' ')).not.toContain('required property');
  });

  it('falls back to schemaPath and a default message when instancePath/message are absent', () => {
    const reasons = blockingValidationReasons([{ keyword: 'pattern', schemaPath: '#/pattern' }]);
    expect(reasons).toEqual(['#/pattern: invalid']);
  });
});
