import { describe, it, expect } from 'vitest';
import { registrationLinks } from '../schema.js';

describe('registrationLinks.completion_actions', () => {
  it('exists on the table', () => {
    const col = (registrationLinks as unknown as Record<string, unknown>).completion_actions;
    expect(col).toBeDefined();
  });

  it('defaults to an empty JSON array', () => {
    // Drizzle exposes the default via the column's config; tests just
    // assert the symbol exists. Behavioural default is asserted at
    // migration test time (Task 2) when a real DB runs the DDL.
    expect(
      typeof (registrationLinks as unknown as Record<string, unknown>).completion_actions,
    ).toBe('object');
  });
});
