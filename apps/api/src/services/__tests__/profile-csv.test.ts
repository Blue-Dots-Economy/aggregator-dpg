import { describe, it, expect } from 'vitest';
import { buildDecryptedProfilesCsv } from '../profile-csv.js';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';

const row = (over: Partial<SignalStackDecryptedProfileRow>): SignalStackDecryptedProfileRow => ({
  item_id: 'i1',
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_state: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('buildDecryptedProfilesCsv', () => {
  it('puts item_id first, then name/phone, then remaining keys sorted', () => {
    const csv = buildDecryptedProfilesCsv([
      row({
        item_id: 'i1',
        item_state: { age: 19, phone: '+91987', name: 'Imran', city: 'Bengaluru' },
      }),
    ]);
    const [header] = csv.split('\r\n');
    expect(header).toBe('item_id,name,phone,age,city');
  });

  it('unions keys across rows and leaves missing cells empty', () => {
    const csv = buildDecryptedProfilesCsv([
      row({ item_id: 'i1', item_state: { name: 'A', age: 19 } }),
      row({ item_id: 'i2', item_state: { name: 'B', city: 'X' } }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('item_id,name,age,city');
    expect(lines[1]).toBe('i1,A,19,');
    expect(lines[2]).toBe('i2,B,,X');
  });

  it('escapes commas, quotes, and newlines; stringifies objects', () => {
    const csv = buildDecryptedProfilesCsv([
      row({
        item_id: 'i1',
        item_state: { name: 'Last, First', note: 'he said "hi"', meta: { a: 1 } },
      }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('item_id,name,meta,note');
    expect(lines[1]).toBe('i1,"Last, First","{""a"":1}","he said ""hi"""');
  });

  it('returns just the item_id header for an empty input', () => {
    expect(buildDecryptedProfilesCsv([])).toBe('item_id');
  });
});
