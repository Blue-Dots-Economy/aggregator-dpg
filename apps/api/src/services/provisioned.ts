/**
 * Marker for accounts an operator provisions (loader or script) instead of
 * the owner registering. Such accounts carry `created_by = provisioned:<operator>`
 * and are created without a consent row: the owner has not consented yet.
 *
 * Belongs to `@aggregator-dpg/api`.
 */
import { ValidationError } from '@aggregator-dpg/shared-primitives/errors';

/** Prefix of `created_by` for an operator-provisioned account. */
export const PROVISIONED_PREFIX = 'provisioned:';

/**
 * The `created_by` value for an account provisioned by `operator`.
 *
 * @param operator - Who runs the provisioning; no whitespace or `:`.
 * @throws ValidationError when `operator` is empty or has whitespace or `:`.
 */
export function provisionedBy(operator: string): string {
  if (operator.length === 0 || /[\s:]/.test(operator)) {
    throw new ValidationError('operator must be non-empty with no whitespace or ":"', {
      code: 'INVALID_OPERATOR',
    });
  }
  return `${PROVISIONED_PREFIX}${operator}`;
}

/**
 * Whether a `created_by` value marks an operator-provisioned account.
 *
 * @param createdBy - The stored `created_by`, if any.
 */
export function isProvisioned(createdBy: string | null | undefined): boolean {
  return typeof createdBy === 'string' && createdBy.startsWith(PROVISIONED_PREFIX);
}
