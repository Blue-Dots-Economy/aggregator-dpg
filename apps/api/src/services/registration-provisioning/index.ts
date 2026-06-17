/**
 * Idempotent provisioning executors for the registration FSM.
 *
 * Each `ensure*` function is safe to call multiple times for the same
 * registration row — it skips work already marked `done` in `provision_state`
 * and retries work marked `failed`. Used by both the inline best-effort path
 * in route handlers and the level-triggered reconciler job.
 *
 * Call order for `approved` → `active` provisioning:
 *   1. `ensureGraduated`   — creates aggregators row; transitions to `active`
 *   2. `ensureKeycloakUser` — find-or-create KC user; enable; set decision claim
 *   3. `ensureSignalstackOrg` — upsert ss org; mirror ss_org_id
 *   4. `ensureWelcomeSent`  — email the applicant
 *
 * For `rejected`:
 *   1. `ensureKeycloakUserDisabled` — disable KC user; set decision=rejected
 *   2. `ensureRejectionSent`        — email the applicant
 *
 * For `abandoned`:
 *   1. `ensurePurged` — delete KC user; PII nulled externally by the reconciler
 */

export type EnsureResult = { ok: true } | { ok: false; error: string };

export {
  ensureVerificationSent,
  type EnsureVerificationSentDeps,
} from './ensure-verification-sent.js';

export { ensureAdminNotified, type EnsureAdminNotifiedDeps } from './ensure-admin-notified.js';

export {
  ensureKeycloakUser,
  ensureKeycloakUserDisabled,
  type EnsureKeycloakUserDeps,
} from './ensure-keycloak-user.js';

export { ensureGraduated, type EnsureGraduatedDeps } from './ensure-graduated.js';

export { ensureSignalstackOrg, type EnsureSignalstackOrgDeps } from './ensure-signalstack-org.js';

export { ensureWelcomeSent, type EnsureWelcomeSentDeps } from './ensure-welcome-sent.js';

export { ensureRejectionSent, type EnsureRejectionSentDeps } from './ensure-rejection-sent.js';

export { ensurePurged, type EnsurePurgedDeps } from './ensure-purged.js';
