import { describe, it, expect } from 'vitest';
import { onboardingService } from '../../services/onboarding.service';

describe('onboardingService', () => {
  it('returns seeker links', async () => {
    const links = await onboardingService.links('seeker');
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.kind === 'Seeker')).toBe(true);
  });

  it('returns provider links', async () => {
    const links = await onboardingService.links('provider');
    expect(links.every((l) => l.kind === 'Provider')).toBe(true);
  });

  it('rejects non-csv uploads', async () => {
    const file = new File(['x'], 'data.txt', { type: 'text/plain' });
    await expect(onboardingService.uploadCsv(file)).rejects.toThrow(/csv/i);
  });

  it('accepts a .csv upload', async () => {
    const file = new File(['name,city'], 'roster.csv', { type: 'text/csv' });
    await expect(onboardingService.uploadCsv(file)).resolves.toEqual({
      accepted: 0,
      rejected: 0,
    });
  });

  it('generates a slug-shaped URL', async () => {
    const result = await onboardingService.generateLink({
      org: 'TRRAIN',
      state: 'Karnataka',
      lever: 'Bluedotathon',
    });
    expect(result.url).toMatch(/^https:\/\/bluedots\.app\/r\/trrain-kar-bluedotathon$/);
  });
});
