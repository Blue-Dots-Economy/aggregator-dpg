/**
 * Type-level tests for the branded ID types. Vitest checks this file with tsc.
 *
 * @module @aggregator-dpg/shared-primitives/ids
 */
import { describe, it, expectTypeOf } from 'vitest';
import { aggregatorId, userId, type AggregatorId, type UserId } from '../ids/index.js';

describe('branded ID types', () => {
  it('does not accept an AggregatorId where a UserId is expected', () => {
    const id = aggregatorId('agg-1');
    // @ts-expect-error an AggregatorId is not a UserId
    const asUser: UserId = id;
    expectTypeOf(asUser).toEqualTypeOf<UserId>();
  });

  it('does not accept a plain string as an ID', () => {
    // @ts-expect-error a plain string is not an AggregatorId
    const fromString: AggregatorId = 'agg-1';
    expectTypeOf(fromString).toEqualTypeOf<AggregatorId>();
  });

  it('accepts a branded ID where a string is expected', () => {
    expectTypeOf(userId('u-1')).toExtend<string>();
  });
});
