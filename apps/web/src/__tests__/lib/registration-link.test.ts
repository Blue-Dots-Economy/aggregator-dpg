/**
 * Unit tests for how the public page parses a resolved registration link.
 *
 * @module @aggregator-dpg/web
 */

import { describe, it, expect } from 'vitest';
import { ResolveResponseSchema } from '@/lib/registration-link';

const BASE = { domain: 'seeker', context: {} };

/** Parses a resolve body with the given `offers` and returns the parsed offers. */
function offersOf(offers: unknown): unknown {
  const body = offers === undefined ? BASE : { ...BASE, offers };
  return ResolveResponseSchema.parse(body).offers;
}

describe('ResolveResponseSchema offers', () => {
  it('defaults to the form only when offers is missing', () => {
    expect(offersOf(undefined)).toEqual(['form']);
  });

  it('keeps known offers in order', () => {
    expect(offersOf(['voice', 'form'])).toEqual(['voice', 'form']);
  });

  it('drops an offer this page does not know, such as callback', () => {
    expect(offersOf(['voice', 'callback', 'form'])).toEqual(['voice', 'form']);
  });

  it('falls back to the form only when no offer is known', () => {
    expect(offersOf(['callback'])).toEqual(['form']);
  });

  it('falls back to the form only when offers is not a list', () => {
    expect(offersOf('voice')).toEqual(['form']);
  });
});
