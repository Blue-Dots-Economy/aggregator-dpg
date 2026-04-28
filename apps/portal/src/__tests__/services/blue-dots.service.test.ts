import { describe, it, expect } from 'vitest';
import { blueDotsService } from '../../services/blue-dots.service';

describe('blueDotsService', () => {
  it('returns all seekers when no filter is provided', async () => {
    const rows = await blueDotsService.seekers();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('id');
  });

  it('filters seekers by status', async () => {
    const atRisk = await blueDotsService.seekers({ status: 'at-risk' });
    expect(atRisk.every((r) => r.status === 'at-risk')).toBe(true);
  });

  it('filters seekers by city substring (case-insensitive)', async () => {
    const hubli = await blueDotsService.seekers({ city: 'hubli' });
    expect(hubli.length).toBeGreaterThan(0);
    expect(hubli.every((r) => r.city.toLowerCase().includes('hubli'))).toBe(true);
  });

  it('filters by free-text search across name/id/title', async () => {
    const results = await blueDotsService.seekers({ search: 'priya' });
    expect(results.some((r) => r.name.toLowerCase().includes('priya'))).toBe(true);
  });

  it('returns empty when no rows match', async () => {
    const none = await blueDotsService.seekers({ search: 'zzz-no-match-zzz' });
    expect(none).toEqual([]);
  });

  it('list dispatches by kind', async () => {
    const seekers = await blueDotsService.list('seeker');
    const providers = await blueDotsService.list('provider');
    const opp = await blueDotsService.list('opp');
    expect(seekers.length).toBeGreaterThan(0);
    expect(providers.length).toBeGreaterThan(0);
    expect(opp.length).toBeGreaterThan(0);
  });

  it('providers carry a role field', async () => {
    const providers = await blueDotsService.providers();
    expect(providers[0]?.role).toEqual(expect.any(String));
  });
});
