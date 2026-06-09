import { describe, it, expect } from 'vitest';
import { registrationLinks } from '../schema.js';

describe('registrationLinks.registrationMode', () => {
  it('is declared as a non-null text column with the snake_case SQL name', () => {
    const col = registrationLinks.registrationMode;
    expect(col).toBeDefined();
    expect(col.name).toBe('registration_mode');
    expect(col.notNull).toBe(true);
  });

  it('does NOT expose a submissionMode column anymore', () => {
    expect(
      (registrationLinks as unknown as Record<string, unknown>).submissionMode,
    ).toBeUndefined();
  });
});
