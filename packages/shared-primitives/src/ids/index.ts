/**
 * Branded nominal ID types for the aggregator-dpg platform.
 *
 * Branded types prevent accidental ID substitution at the type level —
 * an AggregatorId cannot be passed where a UserId is expected.
 *
 * @module @aggregator-dpg/shared-primitives/ids
 */

import { z } from 'zod';

/**
 * Nominal brand helper — adds a phantom type tag so TypeScript treats
 * each ID family as structurally incompatible with every other.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Opaque string ID representing an aggregator tenant. */
export type AggregatorId = Brand<string, 'AggregatorId'>;

/** Opaque string ID representing a platform user. */
export type UserId = Brand<string, 'UserId'>;

/** Opaque string ID representing an organisation. */
export type OrgId = Brand<string, 'OrgId'>;

/** Opaque string ID representing a DSEP network link. */
export type LinkId = Brand<string, 'LinkId'>;

/** Opaque string ID representing a bulk-operation batch. */
export type BatchId = Brand<string, 'BatchId'>;

/** Opaque string ID representing a data export job. */
export type ExportId = Brand<string, 'ExportId'>;

const nonEmptyString = z.string().min(1, 'ID must not be empty');

/**
 * Builds the cast-and-validate function for one branded ID family.
 *
 * Every ID constructor below is the same `nonEmptyString.parse(raw) as X`, so
 * they share one implementation — adding a new ID family is one line, not six.
 *
 * @typeParam B - The brand tag, e.g. `'AggregatorId'`.
 * @returns A function casting a validated non-empty string to `Brand<string, B>`.
 */
function makeId<B extends string>(): (raw: string) => Brand<string, B> {
  return (raw: string) => nonEmptyString.parse(raw) as Brand<string, B>;
}

/**
 * Casts a raw string to AggregatorId after validating it is non-empty.
 *
 * @param raw - Untrusted string value.
 * @returns Branded AggregatorId.
 * @throws {Error} If raw is empty.
 */
export const aggregatorId = makeId<'AggregatorId'>();

/**
 * Casts a raw string to UserId after validating it is non-empty.
 *
 * @param raw - Untrusted string value.
 * @returns Branded UserId.
 * @throws {Error} If raw is empty.
 */
export const userId = makeId<'UserId'>();

/**
 * Casts a raw string to OrgId after validating it is non-empty.
 *
 * @param raw - Untrusted string value.
 * @returns Branded OrgId.
 * @throws {Error} If raw is empty.
 */
export const orgId = makeId<'OrgId'>();

/**
 * Casts a raw string to LinkId after validating it is non-empty.
 *
 * @param raw - Untrusted string value.
 * @returns Branded LinkId.
 * @throws {Error} If raw is empty.
 */
export const linkId = makeId<'LinkId'>();

/**
 * Casts a raw string to BatchId after validating it is non-empty.
 *
 * @param raw - Untrusted string value.
 * @returns Branded BatchId.
 * @throws {Error} If raw is empty.
 */
export const batchId = makeId<'BatchId'>();

/**
 * Casts a raw string to ExportId after validating it is non-empty.
 *
 * @param raw - Untrusted string value.
 * @returns Branded ExportId.
 * @throws {Error} If raw is empty.
 */
export const exportId = makeId<'ExportId'>();
