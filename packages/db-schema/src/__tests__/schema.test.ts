import { describe, it, expect } from 'vitest';
import { registrationLinks } from '../schema.js';

describe('registrationLinks.submissionMode', () => {
  it('is declared as a non-null text column with the snake_case SQL name', () => {
    const col = registrationLinks.submissionMode;
    expect(col).toBeDefined();
    expect(col.name).toBe('submission_mode');
    expect(col.notNull).toBe(true);
  });
});
