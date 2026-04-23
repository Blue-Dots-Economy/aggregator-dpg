/**
 * DrizzleUoW — typed Unit of Work passed to transaction callbacks.
 *
 * Extends UnitOfWork with per-entity repository handles, all bound to the
 * same Drizzle transaction client. Construct via buildUoW(); never build
 * directly.
 *
 * @module @aggregator-dpg/db/postgres (internal)
 */

import { randomUUID } from 'node:crypto';
import type { UnitOfWork } from '../interface.js';
import type { DrizzleDB } from './drizzle.js';
import { AggregatorProfileSchemaRepo } from '../repositories/aggregator-profile-schema.repo.js';
import { AggregatorProfileRepo } from '../repositories/aggregator-profile.repo.js';
import { OnboardingLinkRepo } from '../repositories/onboarding-link.repo.js';
import { BulkUploadBatchRepo } from '../repositories/bulk-upload-batch.repo.js';
import { BulkUploadRowRepo } from '../repositories/bulk-upload-row.repo.js';
import { RegistrationRequestRepo } from '../repositories/registration-request.repo.js';
import { ExportJobRepo } from '../repositories/export-job.repo.js';
import { AuditLogRepo } from '../repositories/audit-log.repo.js';

export type {
  AggregatorProfileSchemaRepo,
  AggregatorProfileRepo,
  OnboardingLinkRepo,
  BulkUploadBatchRepo,
  BulkUploadRowRepo,
  RegistrationRequestRepo,
  ExportJobRepo,
  AuditLogRepo,
};

/**
 * Typed Unit of Work for Drizzle-backed transactions.
 *
 * All repo handles share the same Postgres connection and transaction scope.
 * Changes are committed atomically on success and rolled back on any throw.
 */
export interface DrizzleUoW extends UnitOfWork {
  readonly aggregatorProfileSchema: AggregatorProfileSchemaRepo;
  readonly aggregatorProfile: AggregatorProfileRepo;
  readonly onboardingLink: OnboardingLinkRepo;
  readonly bulkUploadBatch: BulkUploadBatchRepo;
  readonly bulkUploadRow: BulkUploadRowRepo;
  readonly registrationRequest: RegistrationRequestRepo;
  readonly exportJob: ExportJobRepo;
  readonly auditLog: AuditLogRepo;
}

/**
 * Creates a DrizzleUoW with all repo handles bound to the given Drizzle client.
 *
 * Pass a transaction-scoped Drizzle client so all repo operations share the
 * same Postgres connection.
 *
 * @param db - Drizzle client (pool-level or transaction-scoped tx object).
 * @returns Fully populated DrizzleUoW.
 */
export function buildUoW(db: DrizzleDB): DrizzleUoW {
  return {
    transactionId: randomUUID(),
    aggregatorProfileSchema: new AggregatorProfileSchemaRepo(db),
    aggregatorProfile: new AggregatorProfileRepo(db),
    onboardingLink: new OnboardingLinkRepo(db),
    bulkUploadBatch: new BulkUploadBatchRepo(db),
    bulkUploadRow: new BulkUploadRowRepo(db),
    registrationRequest: new RegistrationRequestRepo(db),
    exportJob: new ExportJobRepo(db),
    auditLog: new AuditLogRepo(db),
  };
}
