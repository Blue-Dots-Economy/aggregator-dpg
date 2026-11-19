import { describe, expect, it } from 'vitest';
import { treeRefusalError } from '../org-tree-refusal.js';

describe('treeRefusalError', () => {
  it('maps a limit refusal with the given fields', () => {
    expect(treeRefusalError({ code: 'DEPTH_LIMIT', message: 'x' }, { parent_id: 'p1' })).toEqual({
      code: 'ORG_DEPTH_LIMIT',
      fields: { parent_id: 'p1' },
    });
  });

  it('maps a limit refusal without fields when none are given', () => {
    expect(treeRefusalError({ code: 'CHILD_LIMIT', message: 'x' })).toEqual({
      code: 'ORG_CHILD_LIMIT',
    });
  });

  it('maps an invalid parent to SCHEMA_VALIDATION with its detail', () => {
    expect(treeRefusalError({ code: 'INVALID_PARENT', message: 'x' })).toEqual({
      code: 'SCHEMA_VALIDATION',
      detail: 'The parent must be the network or an active organisation.',
      fields: { parent_id: 'invalid' },
    });
  });

  it('returns null for a store error that is not a tree refusal', () => {
    expect(treeRefusalError({ code: 'DUPLICATE_NAME', message: 'x' })).toBeNull();
  });
});
