import { describe, expect, it } from 'vitest';
import {
  BecknAddressSchema,
  BecknContactSchema,
  BecknLocationSchema,
  GeoJSONGeometrySchema,
} from '../beckn/index.js';

describe('BecknContactSchema', () => {
  it('accepts a well-formed contact and lowercases email', () => {
    const parsed = BecknContactSchema.parse({
      name: 'Rajesh Kumar',
      phone: '+919876543210',
      email: 'Admin@SkillBridge.IN',
    });
    expect(parsed.email).toBe('admin@skillbridge.in');
  });

  it('rejects missing phone', () => {
    expect(() => BecknContactSchema.parse({ name: 'x', email: 'x@x.com' })).toThrow();
  });

  it('rejects an invalid phone shape', () => {
    expect(() => BecknContactSchema.parse({ name: 'x', phone: 'abc', email: 'x@x.com' })).toThrow();
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(() =>
      BecknContactSchema.parse({
        name: 'x',
        phone: '+919999999999',
        email: 'x@x.com',
        extra: 'no',
      }),
    ).toThrow();
  });
});

describe('GeoJSONGeometrySchema', () => {
  it('accepts a Point with coordinates', () => {
    expect(() =>
      GeoJSONGeometrySchema.parse({ type: 'Point', coordinates: [77.5946, 12.9716] }),
    ).not.toThrow();
  });

  it('rejects a Point without coordinates', () => {
    expect(() => GeoJSONGeometrySchema.parse({ type: 'Point' })).toThrow();
  });

  it('requires `geometries` for GeometryCollection (not `coordinates`)', () => {
    expect(() =>
      GeoJSONGeometrySchema.parse({
        type: 'GeometryCollection',
        geometries: [{ type: 'Point', coordinates: [0, 0] }],
      }),
    ).not.toThrow();
    expect(() =>
      GeoJSONGeometrySchema.parse({ type: 'GeometryCollection', coordinates: [0, 0] }),
    ).toThrow();
  });

  it('rejects unknown geometry types', () => {
    expect(() => GeoJSONGeometrySchema.parse({ type: 'Donut' })).toThrow();
  });
});

describe('BecknAddressSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    expect(() => BecknAddressSchema.parse({})).not.toThrow();
  });

  it('rejects extra properties', () => {
    expect(() => BecknAddressSchema.parse({ foo: 'bar' })).toThrow();
  });
});

describe('BecknLocationSchema', () => {
  it('accepts geo + address', () => {
    expect(() =>
      BecknLocationSchema.parse({
        geo: { type: 'Point', coordinates: [77.5946, 12.9716] },
        address: { addressCountry: 'IN' },
      }),
    ).not.toThrow();
  });

  it('accepts geo without address', () => {
    expect(() =>
      BecknLocationSchema.parse({ geo: { type: 'Point', coordinates: [0, 0] } }),
    ).not.toThrow();
  });

  it('rejects when geo is missing', () => {
    expect(() => BecknLocationSchema.parse({ address: {} })).toThrow();
  });
});
