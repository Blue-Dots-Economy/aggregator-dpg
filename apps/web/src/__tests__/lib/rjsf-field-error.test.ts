import { describe, it, expect, vi } from 'vitest';
import { addFieldError } from '@/lib/rjsf-field-error';

describe('addFieldError', () => {
  it('adds the message to the field at the path', () => {
    const addError = vi.fn();
    const errors = { owner: { name: { addError } } };
    expect(addFieldError(errors, ['owner', 'name'], 'Bad name')).toBe(true);
    expect(addError).toHaveBeenCalledWith('Bad name');
  });

  it('adds nothing when the path does not reach a field', () => {
    expect(addFieldError({ owner: {} }, ['owner', 'name'], 'Bad name')).toBe(false);
    expect(addFieldError(undefined, ['name'], 'Bad name')).toBe(false);
  });

  it('adds nothing when the node has no addError function', () => {
    expect(addFieldError({ name: { addError: 'no' } }, ['name'], 'Bad name')).toBe(false);
  });
});
