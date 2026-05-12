/**
 * Re-exports the canonical Drizzle schema from `@aggregator-dpg/db-schema`.
 *
 * The schema lives in a shared package so both `apps/api` and `apps/worker`
 * (and any future service) consume an identical definition. This file is a
 * thin shim — keep it that way.
 */

export * from '@aggregator-dpg/db-schema/schema';
