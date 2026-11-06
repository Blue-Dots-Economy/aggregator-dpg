import { describe, it, expect } from 'vitest';
import { PAGE_SIZE, pageQuery, statusQuery } from '@/app/(protected)/dashboard/_lib/query';

describe('statusQuery', () => {
  it('sends a status only when one is picked', () => {
    expect(statusQuery('all')).toEqual({});
    expect(statusQuery('at_risk')).toEqual({ status: 'at_risk' });
  });
});

describe('pageQuery', () => {
  it('builds the page read with only the active filters', () => {
    expect(pageQuery({ domain: 'seeker', statusFilter: 'all', lifecycleFilter: 'all' }, 1)).toEqual(
      { domain: 'seeker', page: 1, limit: PAGE_SIZE },
    );
    expect(
      pageQuery({ domain: 'seeker', statusFilter: 'new', lifecycleFilter: 'live' }, 3),
    ).toEqual({ domain: 'seeker', page: 3, limit: PAGE_SIZE, status: 'new', lifecycle: 'live' });
  });
});
