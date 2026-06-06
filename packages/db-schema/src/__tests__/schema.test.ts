import { describe, it, expect } from 'vitest';
import { registrationLinks, outboundDispatchLog } from '../schema.js';

describe('registrationLinks.completionActions', () => {
  it('is declared as a non-null jsonb column with the snake_case SQL name', () => {
    const col = registrationLinks.completionActions;
    expect(col).toBeDefined();
    // SQL column name lives on the column metadata
    expect(col.name).toBe('completion_actions');
    expect(col.notNull).toBe(true);
  });
});

describe('outboundDispatchLog', () => {
  it('is defined as a table', () => {
    expect(outboundDispatchLog).toBeDefined();
  });

  it('exposes the expected primary columns with correct SQL names', () => {
    expect(outboundDispatchLog.id.name).toBe('id');
    expect(outboundDispatchLog.aggregatorId.name).toBe('aggregator_id');
    expect(outboundDispatchLog.participantId.name).toBe('participant_id');
    expect(outboundDispatchLog.itemId.name).toBe('item_id');
    expect(outboundDispatchLog.channel.name).toBe('channel');
    expect(outboundDispatchLog.templateId.name).toBe('template_id');
    expect(outboundDispatchLog.status.name).toBe('status');
    expect(outboundDispatchLog.createdAt.name).toBe('created_at');
  });

  it('marks identity columns as not-null', () => {
    expect(outboundDispatchLog.aggregatorId.notNull).toBe(true);
    expect(outboundDispatchLog.participantId.notNull).toBe(true);
    expect(outboundDispatchLog.itemId.notNull).toBe(true);
    expect(outboundDispatchLog.channel.notNull).toBe(true);
    expect(outboundDispatchLog.templateId.notNull).toBe(true);
    expect(outboundDispatchLog.status.notNull).toBe(true);
  });
});
