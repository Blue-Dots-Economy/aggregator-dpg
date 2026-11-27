/**
 * Type-level tests for the branded ID types. Vitest checks this file with tsc.
 *
 * @module @aggregator-dpg/shared-primitives/ids
 */
import { describe, it, expectTypeOf } from 'vitest';
import { orgId, userId, type OrgId, type UserId } from '../ids/index.js';

describe('branded ID types', () => {
  it('does not accept an OrgId where a UserId is expected', () => {
    const id = orgId('org-1');
    // @ts-expect-error an OrgId is not a UserId
    const asUser: UserId = id;
    expectTypeOf(asUser).toEqualTypeOf<UserId>();
  });

  it('does not accept a plain string as an ID', () => {
    // @ts-expect-error a plain string is not an OrgId
    const fromString: OrgId = 'org-1';
    expectTypeOf(fromString).toEqualTypeOf<OrgId>();
  });

  it('accepts a branded ID where a string is expected', () => {
    expectTypeOf(userId('u-1')).toExtend<string>();
  });
});
