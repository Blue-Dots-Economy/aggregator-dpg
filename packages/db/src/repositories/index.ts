/**
 * Repository implementations for all aggregator DB entities.
 *
 * Each class extends Repository<TEntity, string> from the db interface and
 * takes a DrizzleDB instance in its constructor. Wire repos via the UnitOfWork
 * (F-04.6) in production; construct directly with a DrizzleDB for testing.
 *
 * @module @aggregator-dpg/db/repositories
 */

export * from './aggregator-profile-schema.repo.js';
export * from './aggregator-profile.repo.js';
export * from './onboarding-link.repo.js';
export * from './bulk-upload-batch.repo.js';
export * from './bulk-upload-row.repo.js';
export * from './registration-request.repo.js';
export * from './export-job.repo.js';
export * from './audit-log.repo.js';
