import { describe, it, expect } from 'vitest';
import { profileService } from '../../services/profile.service';

describe('profileService', () => {
  it('returns the seeded profile', async () => {
    const profile = await profileService.get();
    expect(profile.org).toBe('TRRAIN');
    expect(profile.id).toMatch(/^AGG-/);
  });

  it('updates and persists patch fields across reads', async () => {
    await profileService.update({ org: 'TRRAIN-Updated' });
    const profile = await profileService.get();
    expect(profile.org).toBe('TRRAIN-Updated');
    await profileService.update({ org: 'TRRAIN' });
  });
});
