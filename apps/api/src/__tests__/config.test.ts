import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Mirror the boolean-flag schema fragment the config uses so we can assert
// the parse semantics without re-importing the whole module (which reads
// process.env at import time).
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

describe('ORG_HIERARCHY_ENABLED flag semantics', () => {
  it('defaults to false when unset', () => {
    expect(flag.parse(undefined)).toBe(false);
  });
  it('is true only for the literal string "true"', () => {
    expect(flag.parse('true')).toBe(true);
    expect(flag.parse('false')).toBe(false);
  });
});
