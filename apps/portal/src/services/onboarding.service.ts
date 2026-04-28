import type { RegistrationLink } from '../types';
import { SEEKER_LINKS, PROVIDER_LINKS } from '../data/mock';

export interface OnboardingService {
  links(kind: 'seeker' | 'provider'): Promise<RegistrationLink[]>;
  uploadCsv(file: File): Promise<{ accepted: number; rejected: number }>;
  generateLink(input: { org: string; state: string; lever: string }): Promise<{ url: string }>;
}

class MockOnboardingService implements OnboardingService {
  async links(kind: 'seeker' | 'provider'): Promise<RegistrationLink[]> {
    return kind === 'seeker' ? SEEKER_LINKS : PROVIDER_LINKS;
  }

  async uploadCsv(file: File): Promise<{ accepted: number; rejected: number }> {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      throw new Error('Only .csv files are accepted');
    }
    return { accepted: 0, rejected: 0 };
  }

  async generateLink(input: {
    org: string;
    state: string;
    lever: string;
  }): Promise<{ url: string }> {
    const slug = `${input.org}-${input.state.slice(0, 3)}-${input.lever}`
      .toLowerCase()
      .replace(/\s+/g, '-');
    return { url: `https://bluedots.app/r/${slug}` };
  }
}

export const onboardingService: OnboardingService = new MockOnboardingService();
