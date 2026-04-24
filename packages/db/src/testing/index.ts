/**
 * Public entry point for in-memory testing fakes.
 *
 * External packages import from @aggregator-dpg/db/testing:
 *
 *   import { InMemoryAuditLogRepo, buildAuditLog } from '@aggregator-dpg/db/testing';
 *
 * @module @aggregator-dpg/db/testing
 */

export { InMemoryRepo } from './_in-memory-repo.js';

export {
  InMemoryAggregatorProfileSchemaRepo,
  buildAggregatorProfileSchema,
} from './aggregator-profile-schema.fake.js';

export {
  InMemoryAggregatorProfileRepo,
  buildAggregatorProfile,
} from './aggregator-profile.fake.js';

export { InMemoryOnboardingLinkRepo, buildOnboardingLink } from './onboarding-link.fake.js';

export { InMemoryBulkUploadBatchRepo, buildBulkUploadBatch } from './bulk-upload-batch.fake.js';

export { InMemoryBulkUploadRowRepo, buildBulkUploadRow } from './bulk-upload-row.fake.js';

export {
  InMemoryRegistrationRequestRepo,
  buildRegistrationRequest,
} from './registration-request.fake.js';

export { InMemoryExportJobRepo, buildExportJob } from './export-job.fake.js';

export { InMemoryAuditLogRepo, buildAuditLog } from './audit-log.fake.js';
