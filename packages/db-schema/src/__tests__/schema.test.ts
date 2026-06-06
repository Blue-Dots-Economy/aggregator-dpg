import { describe, it, expect } from 'vitest';
import { registrationLinks } from '../schema.js';

describe('registrationLinks.completionActions', () => {
  it('is declared as a non-null jsonb column with the snake_case SQL name', () => {
    const col = registrationLinks.completionActions;
    expect(col).toBeDefined();
    // SQL column name lives on the column metadata
    expect(col.name).toBe('completion_actions');
    expect(col.notNull).toBe(true);
  });
});
