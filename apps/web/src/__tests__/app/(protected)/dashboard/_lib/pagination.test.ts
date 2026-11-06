import { describe, it, expect } from 'vitest';
import { buildPageList } from '@/app/(protected)/dashboard/_lib/pagination';

describe('buildPageList', () => {
  it('lists every page up to seven', () => {
    expect(buildPageList(1, 1)).toEqual([1]);
    expect(buildPageList(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('collapses the far side near the start and the end', () => {
    expect(buildPageList(1, 10)).toEqual([1, 2, '…', 10]);
    expect(buildPageList(10, 10)).toEqual([1, '…', 9, 10]);
  });

  it('shows the current page with its neighbours in the middle', () => {
    expect(buildPageList(5, 10)).toEqual([1, '…', 4, 5, 6, '…', 10]);
  });

  it('does not add a gap next to the first or last page', () => {
    expect(buildPageList(3, 10)).toEqual([1, 2, 3, 4, '…', 10]);
    expect(buildPageList(8, 10)).toEqual([1, '…', 7, 8, 9, 10]);
  });
});
