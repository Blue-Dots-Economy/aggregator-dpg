/**
 * Base Data Transfer Object types shared across aggregator-dpg services.
 *
 * These types represent common pagination, filtering, and timestamp
 * structures used at service boundaries.
 *
 * @module @aggregator-dpg/shared-primitives/dto
 */

import { z } from 'zod';

/** Common audit timestamps added to every persisted entity. */
export interface Timestamps {
  createdAt: Date;
  updatedAt: Date;
}

/** Zod schema for Timestamps — parses ISO string or Date to Date. */
export const TimestampsSchema = z.object({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/** Opaque cursor for keyset pagination. */
export interface Cursor {
  /** Base64url-encoded opaque value — callers must not parse this. */
  value: string;
}

/** Zod schema for Cursor. */
export const CursorSchema = z.object({
  value: z.string().min(1),
});

/**
 * Wraps a page of items with pagination metadata.
 *
 * @typeParam T - The item type contained in this page.
 */
export interface Paginated<T> {
  items: T[];
  total: number;
  /** Present when a next page exists; absent on the last page. */
  nextCursor?: Cursor;
}

/**
 * Builds a Zod schema for Paginated<T> given a schema for item T.
 *
 * @param itemSchema - Zod schema for a single item.
 * @returns Zod schema for Paginated<T>.
 */
export function paginatedSchema<T>(itemSchema: z.ZodType<T>) {
  return z.object({
    items: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    nextCursor: CursorSchema.optional(),
  });
}

/** Sort direction for list queries. */
export type SortDirection = 'asc' | 'desc';

/** SortDirection Zod schema. */
export const SortDirectionSchema = z.enum(['asc', 'desc']);

/** Cursor-based paging options for repository and list queries. */
export interface Paging {
  /** Maximum number of items to return. */
  limit?: number;
  /** Opaque cursor value from a previous response. */
  cursor?: string;
}

/** Zod schema for Paging. */
export const PagingSchema = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  cursor: z.string().optional(),
});

/** Sort expression for a named field. */
export interface Sort<TField extends string = string> {
  field: TField;
  direction: SortDirection;
}

/** Zod schema for Sort. */
export const SortSchema = z.object({
  field: z.string().min(1),
  direction: SortDirectionSchema,
});

/** Supported repository filter operators. */
export type FilterOperator = 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains';

/** Zod schema for FilterOperator. */
export const FilterOperatorSchema = z.enum([
  'eq',
  'neq',
  'in',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
]);

/**
 * SQL-free filter condition over a named field.
 *
 * Repositories translate these conditions to their backing store. Callers do
 * not pass SQL fragments, column expressions, or driver-specific values.
 */
export interface FilterCondition<TField extends string = string> {
  field: TField;
  op: FilterOperator;
  value: unknown;
}

/** Zod schema for FilterCondition. */
export const FilterConditionSchema = z.object({
  field: z.string().min(1),
  op: FilterOperatorSchema,
  value: z.unknown(),
});

/**
 * Common filter parameters for list endpoints.
 *
 * Services extend this with domain-specific fields.
 */
export interface Filter<TField extends string = string> extends Paging {
  /** Structured conditions combined by the repository implementation. */
  conditions?: Array<FilterCondition<TField>>;
  /** Field-level sort expressions. */
  sort?: Array<Sort<TField>>;
  /** Legacy single-direction sort hint for simple list endpoints. */
  sortDirection?: SortDirection;
}

/** Zod schema for Filter. */
export const FilterSchema = PagingSchema.extend({
  conditions: z.array(FilterConditionSchema).optional(),
  sort: z.array(SortSchema).optional(),
  sortDirection: SortDirectionSchema.optional(),
});
