import { describe, it, expect } from 'vitest';
import {
  isSelectableRow,
  mapSeekerStatus,
  resolveLifecycleStatus,
  toProviderRow,
  toSeekerRow,
} from '@/app/(protected)/dashboard/_lib/rows';

const item = {
  profile_item_id: 'p1',
  name: 'Alice Seeker',
  profile_status: 'at_risk',
  profile_completion_pct: 60,
  profile_created_at: '2024-03-09T12:00:00.000Z',
  initiated: { create: 1, accept: 2, reject: 3, cancel: 4 },
  received: { create: 5, accept: 6, reject: 7, cancel: 8 },
  actionable_tags: ['missing_contact_phone', 7, null],
};

describe('resolveLifecycleStatus', () => {
  it('keeps a known lifecycle_status', () => {
    expect(resolveLifecycleStatus('draft', 100)).toBe('draft');
    expect(resolveLifecycleStatus('paused', 0)).toBe('paused');
  });

  it('falls back to completion: live at 100%, draft below', () => {
    expect(resolveLifecycleStatus(undefined, 100)).toBe('live');
    expect(resolveLifecycleStatus('retired', 99)).toBe('draft');
  });
});

describe('mapSeekerStatus', () => {
  it('maps at_risk and inactive, and everything else to active', () => {
    expect(mapSeekerStatus('at_risk')).toBe('at-risk');
    expect(mapSeekerStatus('inactive')).toBe('inactive');
    expect(mapSeekerStatus('new')).toBe('active');
    expect(mapSeekerStatus(null)).toBe('active');
  });
});

describe('toSeekerRow', () => {
  it('maps a full item', () => {
    const row = toSeekerRow(item, 'en', 0);
    expect(row).toMatchObject({
      id: 'p1',
      name: 'Alice Seeker',
      city: '—',
      joined: 'Mar 09, 2024',
      avatar: 'AS',
      profile: { complete: 60, verified: false },
      status: 'at-risk',
      lifecycle_status: 'draft',
      actionableTags: ['missing_contact_phone'],
      applied: { total: 36, accepted: 8, rejected: 10, pending: 6, cancelled: 12 },
    });
    expect(row.initiated).toEqual({ create: 1, accept: 2, reject: 3, cancel: 4 });
  });

  it('falls back for a bare item', () => {
    const row = toSeekerRow({ name: '   ', actionable_tags: 'x' }, 'en', 3);
    expect(row).toMatchObject({
      id: 'row-3',
      name: '—',
      joined: '—',
      last: '—',
      avatar: '??',
      status: 'active',
      lifecycle_status: 'draft',
      actionableTags: [],
      profile: { complete: 0 },
    });
    expect(row.initiated).toEqual({ create: 0, accept: 0, reject: 0, cancel: 0 });
  });
});

describe('toProviderRow', () => {
  it('maps like a seeker row with an empty role', () => {
    expect(toProviderRow(item, 'en', 0)).toEqual({ ...toSeekerRow(item, 'en', 0), role: '—' });
  });
});

describe('isSelectableRow', () => {
  it('rejects rows with a synthetic id', () => {
    expect(isSelectableRow({ id: 'p1' })).toBe(true);
    expect(isSelectableRow({ id: 'row-0' })).toBe(false);
  });
});
