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
 * Casts a raw string to AggregatorId after validating it is non-empty.
 *
 * @param raw - Untrusted string value.
 * @returns Branded AggregatorId.
 * @throws {Error} If raw is empty.
 */
export function aggregatorId(raw: string): AggregatorId {
  return nonEmptyString.parse(raw) as AggregatorId;
}

/**
 * Casts a raw string to UserId after validating it is non-empty.
 *
 * @param raw - Untrusted string value.
 * @returns Branded UserId.
 * @throws {Error} If raw is empty.
 */
export function userId(raw: string): UserId {
  return nonEmptyString.parse(raw) as UserId;
}

/**
 * Casts a raw string to OrgId after validating it is non-empty.
 *
 * @param raw - Untrusted string value.
 * @returns Branded OrgId.
 * @throws {Error} If raw is empty.
 */
export function orgId(raw: string): OrgId {
  return nonEmptyString.parse(raw) as OrgId;
}

/**
 * Casts a raw string to LinkId after validating it is non-empty.
 *
 * @param raw - Untrusted string value.
 * @returns Branded LinkId.
 * @throws {Error} If raw is empty.
 */
export function linkId(raw: string): LinkId {
  return nonEmptyString.parse(raw) as LinkId;
}

/**
 * Casts a raw string to BatchId after validating it is non-empty.
 *
 * @param raw - Untrusted string value.
 * @returns Branded BatchId.
 * @throws {Error} If raw is empty.
 */
export function batchId(raw: string): BatchId {
  return nonEmptyString.parse(raw) as BatchId;
}

/**
 * Casts a raw string to ExportId after validating it is non-empty.
 *
 * @param raw - Untrusted string value.
 * @returns Branded ExportId.
 * @throws {Error} If raw is empty.
 */
export function exportId(raw: string): ExportId {
  return nonEmptyString.parse(raw) as ExportId;
}
