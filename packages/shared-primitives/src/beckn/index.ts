/**
 * Zod schemas and inferred TypeScript types for the Beckn Protocol v2.0
 * objects used by aggregator-dpg.
 *
 * Sources of truth:
 *   - Contact   — https://schema.beckn.io/Contact/v2.0/attributes.yaml
 *   - Location  — https://schema.beckn.io/Location/2.0
 *   - Address   — https://schema.beckn.io/Address/v2.0/attributes.yaml
 *   - GeoJSON   — https://schema.beckn.io/GeoJSONGeometry/v2.0/attributes.yaml
 *
 * Beckn leaves most fields optional. Here `phone` and `email` on Contact are
 * required. Each location's GeoJSON `type` is validated here because Postgres
 * cannot check it.
 *
 * @module @aggregator-dpg/shared-primitives/beckn
 */

import { z } from 'zod';

// ─── Phone normalisation ────────────────────────────────────────────────────

/**
 * What a typed phone may contain: an optional leading `+`, digits, spaces,
 * dashes, dots and brackets. The country rules are checked later by `parsePhone`.
 */
const PHONE_INPUT_REGEX = /^\+?[\d\s\-().]+$/;

/** Longest typed phone accepted: 15 digits plus room for spacing and punctuation. */
const PHONE_INPUT_MAX_LENGTH = 32;

/** An alternate phone is stored as sent, so it keeps the plain digits pattern. */
const ALTERNATE_PHONE_REGEX = /^(\+?\d{10,15}|\d{10})$/;

// ─── Beckn Contact ──────────────────────────────────────────────────────────

export const BecknContactSchema = z
  .object({
    name: z.string().min(1).max(200),
    phone: z
      .string()
      .max(PHONE_INPUT_MAX_LENGTH)
      .regex(PHONE_INPUT_REGEX, 'phone may contain only digits, +, spaces, dashes and brackets'),
    email: z.email().max(320).toLowerCase(),
    alternatePhone: z.string().regex(ALTERNATE_PHONE_REGEX).optional(),
    company: z.string().max(200).optional(),
    gstNumber: z.string().max(32).optional(),
  })
  .strict();

export type BecknContact = z.infer<typeof BecknContactSchema>;

// ─── Beckn Address ──────────────────────────────────────────────────────────

export const BecknAddressSchema = z
  .object({
    streetAddress: z.string().optional(),
    extendedAddress: z.string().optional(),
    addressLocality: z.string().optional(),
    addressRegion: z.string().optional(),
    postalCode: z.string().optional(),
    addressCountry: z.string().optional(),
  })
  .strict();

export type BecknAddress = z.infer<typeof BecknAddressSchema>;

// ─── GeoJSON Geometry (Beckn flavour) ───────────────────────────────────────

export const GeoJSONGeometryTypeSchema = z.enum([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'GeometryCollection',
]);

export type GeoJSONGeometryType = z.infer<typeof GeoJSONGeometryTypeSchema>;

export const GeoJSONGeometrySchema = z
  .object({
    type: GeoJSONGeometryTypeSchema,
    coordinates: z.array(z.unknown()).optional(),
    geometries: z.array(z.unknown()).optional(),
    bbox: z.array(z.number()).length(4).optional(),
  })
  .strict()
  .refine(
    (g) =>
      g.type === 'GeometryCollection' ? Array.isArray(g.geometries) : Array.isArray(g.coordinates),
    {
      message: 'coordinates is required (or `geometries` for type=GeometryCollection)',
      path: ['coordinates'],
    },
  );

export type GeoJSONGeometry = z.infer<typeof GeoJSONGeometrySchema>;

// ─── Beckn Location ─────────────────────────────────────────────────────────

export const BecknLocationSchema = z
  .object({
    geo: GeoJSONGeometrySchema,
    address: BecknAddressSchema.optional(),
  })
  .strict();

export type BecknLocation = z.infer<typeof BecknLocationSchema>;
