/**
 * Unit tests for the `content.variables` → audit `piiFields` boundary
 * sanitiser (aggregator-dpg#617, fix-round-1). See
 * `../audit-field-names.ts` for why this boundary exists.
 *
 * @module apps/api/campaign/audit-field-names.test
 */
import { describe, it, expect } from 'vitest';
import { sanitizeAuditFieldNames, auditFieldNameEntries } from '../audit-field-names.js';

describe('sanitizeAuditFieldNames', () => {
  it('passes identifier-shaped names through unchanged, in order', () => {
    const result = sanitizeAuditFieldNames(['role', 'city', 'signalstack_org_id']);
    expect(result).toEqual({ names: ['role', 'city', 'signalstack_org_id'], droppedCount: 0 });
  });

  it('drops a value containing a space', () => {
    const result = sanitizeAuditFieldNames(['role', 'Ananya Rao']);
    expect(result.names).toEqual(['role']);
    expect(result.droppedCount).toBe(1);
  });

  it('drops a value containing an @', () => {
    const result = sanitizeAuditFieldNames(['role', 'ananya@example.org']);
    expect(result.names).toEqual(['role']);
    expect(result.droppedCount).toBe(1);
  });

  it('drops a value that starts with a digit', () => {
    const result = sanitizeAuditFieldNames(['role', '2fa_code']);
    expect(result.names).toEqual(['role']);
    expect(result.droppedCount).toBe(1);
  });

  it('drops a value carrying phone-shaped punctuation', () => {
    const result = sanitizeAuditFieldNames(['role', '+919876543210']);
    expect(result.names).toEqual(['role']);
    expect(result.droppedCount).toBe(1);
  });

  it('reports the count accurately when everything is dropped', () => {
    const result = sanitizeAuditFieldNames(['Ananya Rao', 'ananya@example.org']);
    expect(result).toEqual({ names: [], droppedCount: 2 });
  });

  it('returns zero dropped for an empty input', () => {
    expect(sanitizeAuditFieldNames([])).toEqual({ names: [], droppedCount: 0 });
  });

  it('never mutates the input array', () => {
    const input = ['role', 'Ananya Rao'];
    const copy = [...input];
    sanitizeAuditFieldNames(input);
    expect(input).toEqual(copy);
  });
});

describe('auditFieldNameEntries', () => {
  it('returns only the names when nothing was dropped', () => {
    expect(auditFieldNameEntries(['role', 'city'])).toEqual(['role', 'city']);
  });

  it('appends a redaction-count summary, never the dropped value itself', () => {
    const entries = auditFieldNameEntries(['role', 'Ananya Rao', 'ananya@example.org']);
    expect(entries).toEqual(['role', '+2 redacted (non-identifier)']);
    expect(entries.join(' ')).not.toContain('Ananya Rao');
    expect(entries.join(' ')).not.toContain('ananya@example.org');
  });

  it('returns an empty array for an empty input', () => {
    expect(auditFieldNameEntries([])).toEqual([]);
  });
});
