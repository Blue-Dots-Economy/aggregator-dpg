/**
 * Maps an organisation tree refusal from the store to its API error.
 *
 * One mapping for every caller, so console routes and org creation answer the
 * same store error the same way. Belongs to `@aggregator-dpg/api`.
 */

import type { OrgStoreError } from './organisation-store/interface.js';

/** API error codes a tree refusal maps to; each is a key of the error catalogue. */
export type TreeRefusalCode =
  | 'CONFLICT'
  | 'SCHEMA_VALIDATION'
  | 'ORG_PARENT_CYCLE'
  | 'ORG_DEPTH_LIMIT'
  | 'ORG_CHILD_LIMIT'
  | 'ORG_TOTAL_LIMIT';

/** The API error for a tree refusal. */
export interface TreeRefusalError {
  code: TreeRefusalCode;
  /** Replaces the catalogue detail for this occurrence. */
  detail?: string;
  fields?: Record<string, unknown>;
}

/**
 * Returns the API error for an organisation tree refusal, or `null` for any other store error.
 *
 * @param e - The store error.
 * @param fields - Error fields added to `ORG_DEPTH_LIMIT` and `ORG_CHILD_LIMIT`.
 */
export function treeRefusalError(
  e: OrgStoreError,
  fields?: Record<string, unknown>,
): TreeRefusalError | null {
  const limitFields = fields ? { fields } : {};
  switch (e.code) {
    case 'NOT_MOVABLE':
      return {
        code: 'CONFLICT',
        detail: 'This organisation cannot be moved.',
        fields: { reason: 'not_movable' },
      };
    case 'ORG_BUSY':
      return {
        code: 'CONFLICT',
        detail: 'The organisation is being changed. Try again.',
        fields: { reason: 'busy' },
      };
    case 'INVALID_PARENT':
      return {
        code: 'SCHEMA_VALIDATION',
        detail: 'The parent must be the network or an active organisation.',
        fields: { parent_id: 'invalid' },
      };
    case 'PARENT_CYCLE':
      return { code: 'ORG_PARENT_CYCLE' };
    case 'DEPTH_LIMIT':
      return { code: 'ORG_DEPTH_LIMIT', ...limitFields };
    case 'CHILD_LIMIT':
      return { code: 'ORG_CHILD_LIMIT', ...limitFields };
    case 'TOTAL_LIMIT':
      return { code: 'ORG_TOTAL_LIMIT' };
    default:
      return null;
  }
}
