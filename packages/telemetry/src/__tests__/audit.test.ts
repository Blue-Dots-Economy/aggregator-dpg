import { describe, expect, it, vi } from 'vitest';
import { emitAudit } from '../audit.js';

describe('emitAudit', () => {
  it('writes a structured record to the supplied logger', () => {
    const warn = vi.fn();
    emitAudit(
      { event: 'bulk_row.processed', entity_id: 'r-1', attributes: { aggregator_id: 'a-1' } },
      { warn } as never,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'telemetry.audit.emit',
        event_kind: 'audit',
        event: 'bulk_row.processed',
        entity_id: 'r-1',
      }),
      'audit',
    );
  });
});
