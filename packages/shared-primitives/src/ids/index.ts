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
 * Nominal brand helper. Adds Zod's phantom brand tag, so TypeScript treats
 * each ID family as incompatible with every other, and a branded Zod schema
 * produces the type without a cast.
 */
export type Brand<T, B extends string> = T & z.BRAND<B>;

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

/** Branded schemas, one per ID family. */
const AggregatorIdSchema = nonEmptyString.brand<'AggregatorId'>();
const UserIdSchema = nonEmptyString.brand<'UserId'>();
const OrgIdSchema = nonEmptyString.brand<'OrgId'>();
const LinkIdSchema = nonEmptyString.brand<'LinkId'>();
const BatchIdSchema = nonEmptyString.brand<'BatchId'>();
const ExportIdSchema = nonEmptyString.brand<'ExportId'>();

/**
 * Validates that a raw string is non-empty and brands it as AggregatorId.
 *
 * @param raw - Untrusted string value.
 * @returns Branded AggregatorId.
 * @throws {z.ZodError} If raw is empty.
 */
export function aggregatorId(raw: string): AggregatorId {
  return AggregatorIdSchema.parse(raw);
}

/**
 * Validates that a raw string is non-empty and brands it as UserId.
 *
 * @param raw - Untrusted string value.
 * @returns Branded UserId.
 * @throws {z.ZodError} If raw is empty.
 */
export function userId(raw: string): UserId {
  return UserIdSchema.parse(raw);
}

/**
 * Validates that a raw string is non-empty and brands it as OrgId.
 *
 * @param raw - Untrusted string value.
 * @returns Branded OrgId.
 * @throws {z.ZodError} If raw is empty.
 */
export function orgId(raw: string): OrgId {
  return OrgIdSchema.parse(raw);
}

/**
 * Validates that a raw string is non-empty and brands it as LinkId.
 *
 * @param raw - Untrusted string value.
 * @returns Branded LinkId.
 * @throws {z.ZodError} If raw is empty.
 */
export function linkId(raw: string): LinkId {
  return LinkIdSchema.parse(raw);
}

/**
 * Validates that a raw string is non-empty and brands it as BatchId.
 *
 * @param raw - Untrusted string value.
 * @returns Branded BatchId.
 * @throws {z.ZodError} If raw is empty.
 */
export function batchId(raw: string): BatchId {
  return BatchIdSchema.parse(raw);
}

/**
 * Validates that a raw string is non-empty and brands it as ExportId.
 *
 * @param raw - Untrusted string value.
 * @returns Branded ExportId.
 * @throws {z.ZodError} If raw is empty.
 */
export function exportId(raw: string): ExportId {
  return ExportIdSchema.parse(raw);
}
