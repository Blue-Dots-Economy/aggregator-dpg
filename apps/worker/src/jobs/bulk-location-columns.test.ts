import { describe, it, expect } from 'vitest';
import { BULK_LOCATION_COLUMNS, extractBulkItemLocations } from './bulk-location-columns.js';

describe('extractBulkItemLocations', () => {
  it('returns nothing for a row with no coordinate columns at all', () => {
    const payload: Record<string, unknown> = { name: 'Acme', role: 'Electrician' };

    const result = extractBulkItemLocations(payload);

    expect(result).toEqual({ locations: null, ignored: null });
    expect(payload).toEqual({ name: 'Acme', role: 'Electrician' });
  });

  it('treats both cells empty as "no coordinate", not as an error', () => {
    const payload: Record<string, unknown> = {
      name: 'Acme',
      latitude: '',
      longitude: '   ',
      location_label: '',
    };

    const result = extractBulkItemLocations(payload);

    expect(result).toEqual({ locations: null, ignored: null });
  });

  it('resolves a valid pair', () => {
    const result = extractBulkItemLocations({ latitude: '12.9716', longitude: '77.5946' });

    expect(result.ignored).toBeNull();
    expect(result.locations).toEqual([{ lat: 12.9716, lng: 77.5946 }]);
  });

  it('carries the label through when one is given', () => {
    const result = extractBulkItemLocations({
      latitude: '12.9716',
      longitude: '77.5946',
      location_label: 'Head Office',
    });

    expect(result.locations).toEqual([{ lat: 12.9716, lng: 77.5946, label: 'Head Office' }]);
  });

  it('omits the label key entirely when the cell is blank', () => {
    const result = extractBulkItemLocations({
      latitude: '12.9716',
      longitude: '77.5946',
      location_label: '  ',
    });

    expect(result.locations).toEqual([{ lat: 12.9716, lng: 77.5946 }]);
    expect(result.locations?.[0]).not.toHaveProperty('label');
  });

  it('accepts numeric cells and trims padded strings', () => {
    expect(extractBulkItemLocations({ latitude: 12.9716, longitude: 77.5946 }).locations).toEqual([
      { lat: 12.9716, lng: 77.5946 },
    ]);
    expect(
      extractBulkItemLocations({ latitude: ' 12.9716 ', longitude: ' 77.5946 ' }).locations,
    ).toEqual([{ lat: 12.9716, lng: 77.5946 }]);
  });

  it('accepts negative and zero coordinates', () => {
    expect(extractBulkItemLocations({ latitude: '0', longitude: '0' }).locations).toEqual([
      { lat: 0, lng: 0 },
    ]);
    expect(
      extractBulkItemLocations({ latitude: '-33.8688', longitude: '-70.6693' }).locations,
    ).toEqual([{ lat: -33.8688, lng: -70.6693 }]);
  });

  it.each([
    ['latitude set, longitude blank', { latitude: '12.9716', longitude: '' }],
    ['longitude set, latitude blank', { latitude: '', longitude: '77.5946' }],
    ['latitude not numeric', { latitude: 'abc', longitude: '77.5946' }],
    ['longitude not numeric', { latitude: '12.9716', longitude: 'east' }],
    ['latitude out of range', { latitude: '95', longitude: '77.5946' }],
    ['longitude out of range', { latitude: '12.9716', longitude: '-181' }],
  ])('ignores an unusable pair (%s) without failing the row', (_label, cells) => {
    const result = extractBulkItemLocations({ ...cells });

    expect(result.locations).toBeNull();
    expect(result.ignored).not.toBeNull();
    expect(result.ignored?.reason).toBeTruthy();
  });

  it('reports the raw cells on the ignored reason so a bad generator is traceable', () => {
    const result = extractBulkItemLocations({ latitude: 'abc', longitude: '77.5946' });

    expect(result.ignored).toEqual({
      latitude: 'abc',
      longitude: '77.5946',
      reason: expect.stringContaining('latitude'),
    });
  });

  it('always deletes its columns from the payload, whatever the outcome', () => {
    for (const cells of [
      { latitude: '12.9716', longitude: '77.5946', location_label: 'HQ' },
      { latitude: 'abc', longitude: '77.5946', location_label: 'HQ' },
      { latitude: '', longitude: '', location_label: '' },
    ]) {
      const payload: Record<string, unknown> = { name: 'Acme', ...cells };

      extractBulkItemLocations(payload);

      for (const column of BULK_LOCATION_COLUMNS) {
        expect(payload).not.toHaveProperty(column);
      }
      expect(payload).toEqual({ name: 'Acme' });
    }
  });
});
