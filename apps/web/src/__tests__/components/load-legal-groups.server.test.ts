import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getTranslations } = vi.hoisted(() => ({ getTranslations: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations }));

const { loadParticipantConsent } = vi.hoisted(() => ({ loadParticipantConsent: vi.fn() }));
vi.mock('@/lib/participant-consent.server', () => ({ loadParticipantConsent }));

const { loadConsentConfig } = vi.hoisted(() => ({ loadConsentConfig: vi.fn() }));
vi.mock('@aggregator-dpg/config-loader/fs', () => ({ loadConsentConfig }));

const labels: Record<string, string> = {
  audience_participant: 'For participants',
  audience_aggregator: 'For aggregators',
  audience_org: 'For organisations',
};

function t(key: string): string {
  return labels[key] ?? key;
}

const { loadLegalGroups } = await import('@/components/legal/load-legal-groups.server');

const aggregatorOrgConfig = {
  audiences: {
    aggregator: {
      documents: {
        terms: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Terms of Service',
              content: '## Terms of Service',
              effective_from: '2026-07-01',
            },
          ],
        },
        privacy: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Privacy Policy',
              content: '## Privacy Policy',
              effective_from: '2026-07-01',
            },
          ],
        },
      },
    },
    org: {
      documents: {
        terms: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Terms of Service',
              content: '## Terms of Service',
              effective_from: '2026-07-01',
            },
          ],
        },
        privacy: {
          current_version: 1,
          versions: [
            {
              version: 1,
              title: 'Privacy Policy',
              content: '## Privacy Policy',
              effective_from: '2026-07-01',
            },
          ],
        },
      },
    },
  },
};

const participantContent = {
  terms: { version: 1, title: 'Terms of Service', content: '## Terms of Service' },
  privacy: { version: 1, title: 'Privacy Policy', content: '## Privacy Policy' },
};

describe('loadLegalGroups', () => {
  beforeEach(() => {
    getTranslations.mockReset().mockResolvedValue(t);
    loadParticipantConsent.mockReset();
    loadConsentConfig.mockReset();
  });

  afterEach(() => {
    delete process.env.AGGREGATOR_NETWORK;
    delete process.env.AGGREGATOR_BRAND;
  });

  it('returns all three audience groups in participant, aggregator, org order', async () => {
    loadParticipantConsent.mockResolvedValue(participantContent);
    loadConsentConfig.mockResolvedValue(aggregatorOrgConfig);

    const groups = await loadLegalGroups();

    expect(groups.map((g) => g.audience)).toEqual(['participant', 'aggregator', 'org']);
    expect(groups[0]!.label).toBe('For participants');
    expect(groups[1]!.label).toBe('For aggregators');
    expect(groups[2]!.label).toBe('For organisations');
  });

  it('omits the participant group when its content fails to load, without affecting aggregator/org', async () => {
    loadParticipantConsent.mockResolvedValue(null);
    loadConsentConfig.mockResolvedValue(aggregatorOrgConfig);

    const groups = await loadLegalGroups();

    expect(groups.map((g) => g.audience)).toEqual(['aggregator', 'org']);
  });

  it('omits the participant group when its loader throws', async () => {
    loadParticipantConsent.mockRejectedValue(new Error('boom'));
    loadConsentConfig.mockResolvedValue(aggregatorOrgConfig);

    const groups = await loadLegalGroups();

    expect(groups.map((g) => g.audience)).toEqual(['aggregator', 'org']);
  });

  it('omits both aggregator and org groups when loadConsentConfig throws, without affecting participant', async () => {
    loadParticipantConsent.mockResolvedValue(participantContent);
    loadConsentConfig.mockRejectedValue(new Error('config missing'));

    const groups = await loadLegalGroups();

    expect(groups.map((g) => g.audience)).toEqual(['participant']);
  });

  it('returns an empty array when every audience fails to load', async () => {
    loadParticipantConsent.mockResolvedValue(null);
    loadConsentConfig.mockRejectedValue(new Error('config missing'));

    const groups = await loadLegalGroups();

    expect(groups).toEqual([]);
  });

  it('carries the effective_from date through for aggregator/org documents', async () => {
    loadParticipantConsent.mockResolvedValue(null);
    loadConsentConfig.mockResolvedValue(aggregatorOrgConfig);

    const groups = await loadLegalGroups();

    expect(groups[0]!.content.privacy.effective_from).toBe('2026-07-01');
  });

  it('reads network/brand from AGGREGATOR_NETWORK / AGGREGATOR_BRAND env vars', async () => {
    process.env.AGGREGATOR_NETWORK = 'orange_dot';
    process.env.AGGREGATOR_BRAND = 'onetac';
    loadParticipantConsent.mockResolvedValue(null);
    loadConsentConfig.mockResolvedValue(aggregatorOrgConfig);

    await loadLegalGroups();

    expect(loadConsentConfig).toHaveBeenCalledWith('orange_dot', 'onetac');
  });
});
