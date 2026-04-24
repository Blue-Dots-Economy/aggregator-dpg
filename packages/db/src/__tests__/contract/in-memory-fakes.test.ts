/**
 * Contract tests for the full set of InMemory*Repo fakes.
 *
 * Each fake is exercised against the shared Repository contract suite so
 * behaviour stays in lockstep with the Postgres implementation.
 *
 * @module @aggregator-dpg/db/__tests__/contract
 */

import {
  InMemoryAggregatorProfileSchemaRepo,
  InMemoryAggregatorProfileRepo,
  InMemoryOnboardingLinkRepo,
  InMemoryBulkUploadBatchRepo,
  InMemoryBulkUploadRowRepo,
  InMemoryRegistrationRequestRepo,
  InMemoryExportJobRepo,
  InMemoryAuditLogRepo,
} from '../../testing/index.js';
import { runRepoContract, runAppendOnlyRepoContract } from './repo-contract.js';

// ── AggregatorProfileSchema ──────────────────────────────────────────────
runRepoContract(
  'InMemoryAggregatorProfileSchemaRepo',
  () => new InMemoryAggregatorProfileSchemaRepo(),
  {
    sampleCreateInput: () => ({
      version: '1',
      schemaJson: {},
      active: false,
    }),
    samplePatch: () => ({ active: true }),
    patchedField: 'active',
    getId: (e) => e.id,
    emptyFilter: {},
    matchingFilter: (e) => ({ version: e.version }),
    nonMatchingFilter: { version: 'non-existent-version' },
  },
);

// ── AggregatorProfile ────────────────────────────────────────────────────
runRepoContract('InMemoryAggregatorProfileRepo', () => new InMemoryAggregatorProfileRepo(), {
  sampleCreateInput: () => ({
    schemaVersion: 'schema-1',
    valuesJson: { foo: 'bar' },
  }),
  samplePatch: () => ({ valuesJson: { updated: true } }),
  patchedField: 'valuesJson',
  getId: (e) => e.aggregatorId,
  emptyFilter: {},
  matchingFilter: (e) => ({ schemaVersion: e.schemaVersion }),
  nonMatchingFilter: { schemaVersion: 'does-not-exist' },
});

// ── OnboardingLink ───────────────────────────────────────────────────────
runRepoContract('InMemoryOnboardingLinkRepo', () => new InMemoryOnboardingLinkRepo(), {
  sampleCreateInput: () => ({
    aggregatorId: 'agg-1',
    mode: 'link',
    targetRole: 'seeker',
    label: 'Hiring Drive',
    joinCount: 0,
    expiresAt: null,
    revokedAt: null,
  }),
  samplePatch: () => ({ label: 'Patched Label' }),
  patchedField: 'label',
  getId: (e) => e.id,
  emptyFilter: {},
  matchingFilter: (e) => ({ aggregatorId: e.aggregatorId }),
  nonMatchingFilter: { aggregatorId: 'does-not-exist' },
});

// ── BulkUploadBatch ──────────────────────────────────────────────────────
runRepoContract('InMemoryBulkUploadBatchRepo', () => new InMemoryBulkUploadBatchRepo(), {
  sampleCreateInput: () => ({
    aggregatorId: 'agg-1',
    filename: 'data.csv',
    total: 10,
    succeeded: 8,
    flagged: 2,
    createdBy: 'user-1',
  }),
  samplePatch: () => ({ succeeded: 9 }),
  patchedField: 'succeeded',
  getId: (e) => e.id,
  emptyFilter: {},
  matchingFilter: (e) => ({ aggregatorId: e.aggregatorId }),
  nonMatchingFilter: { aggregatorId: 'does-not-exist' },
});

// ── BulkUploadRow ────────────────────────────────────────────────────────
runRepoContract('InMemoryBulkUploadRowRepo', () => new InMemoryBulkUploadRowRepo(), {
  sampleCreateInput: () => ({
    batchId: 'batch-1',
    rowNumber: 1,
    rawRowJson: { name: 'Alice' },
    outcome: 'success',
    errorCode: null,
    errorMessage: null,
  }),
  samplePatch: () => ({ outcome: 'flagged' as const }),
  patchedField: 'outcome',
  getId: (e) => e.id,
  emptyFilter: {},
  matchingFilter: (e) => ({ batchId: e.batchId }),
  nonMatchingFilter: { batchId: 'does-not-exist' },
});

// ── RegistrationRequest ──────────────────────────────────────────────────
runRepoContract('InMemoryRegistrationRequestRepo', () => new InMemoryRegistrationRequestRepo(), {
  sampleCreateInput: () => ({
    orgName: 'Acme',
    aggregatorType: 'employer',
    adminName: 'Alice',
    email: 'alice@acme.test',
    phone: '+911234567890',
    consentAt: new Date('2024-06-01T00:00:00Z'),
    status: 'pending',
  }),
  samplePatch: () => ({ status: 'approved' as const }),
  patchedField: 'status',
  getId: (e) => e.id,
  emptyFilter: {},
  matchingFilter: (e) => ({ email: e.email }),
  nonMatchingFilter: { email: 'nobody@example.com' },
});

// ── ExportJob ────────────────────────────────────────────────────────────
runRepoContract('InMemoryExportJobRepo', () => new InMemoryExportJobRepo(), {
  sampleCreateInput: () => ({
    aggregatorId: 'agg-1',
    filterJson: { from: '2024-01-01' },
    status: 'pending',
    fileUrl: null,
  }),
  samplePatch: () => ({ status: 'completed' as const }),
  patchedField: 'status',
  getId: (e) => e.id,
  emptyFilter: {},
  matchingFilter: (e) => ({ aggregatorId: e.aggregatorId }),
  nonMatchingFilter: { aggregatorId: 'does-not-exist' },
});

// ── AuditLog (append-only) ───────────────────────────────────────────────
runAppendOnlyRepoContract(
  'InMemoryAuditLogRepo',
  () => new InMemoryAuditLogRepo(),
  {
    sampleCreateInput: () => ({
      aggregatorId: 'agg-1',
      userId: 'user-1',
      action: 'create',
      entity: 'onboarding_link',
      entityId: 'link-1',
      payloadJson: null,
      occurredAt: new Date('2024-06-01T00:00:00Z'),
    }),
    samplePatch: () => ({ action: 'update' }),
    patchedField: 'action',
    getId: (e) => e.id,
    emptyFilter: {},
    matchingFilter: (e) => ({ aggregatorId: e.aggregatorId }),
    nonMatchingFilter: { aggregatorId: 'does-not-exist' },
  },
  'AUDIT_LOG_IMMUTABLE',
);
