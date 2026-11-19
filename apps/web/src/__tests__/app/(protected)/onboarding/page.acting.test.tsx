/**
 * The Onboarding page while an org owner acts as their own coordinator
 * account: given a `200` from `/api/aggregator/profile/me` (the read the
 * API answers for an acting owner), the page shows its content, not an
 * access notice. `fetch` is the boundary; the profile hook and the domain
 * gate run for real. `Topbar` and the card bodies are stubbed as in
 * `page.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { AuthProvider } from '@/lib/auth-context';
import messages from '@/i18n/messages/en.json';
import { makeQueryClient } from '@/__tests__/test-utils';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/onboarding',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('@/app/(protected)/onboarding/_components/CSVUpload', () => ({
  RecentUploadsBody: () => <div data-testid="recent-uploads-body" />,
}));
vi.mock('@/app/(protected)/onboarding/_components/RegistrationLinksSection', () => ({
  YourLinksBody: () => <div data-testid="your-links-body" />,
}));
vi.mock('@/app/(protected)/onboarding/_components/OnboardingMetrics', () => ({
  OnboardingMetrics: () => <div data-testid="onboarding-metrics" />,
}));
const { useRegistrationLinks } = vi.hoisted(() => ({ useRegistrationLinks: vi.fn() }));
vi.mock('@/hooks/useOnboarding', () => ({
  useRecentBulkUploads: () => ({ data: { items: [] }, isLoading: false }),
  useRegistrationLinks: (...args: unknown[]) => useRegistrationLinks(...args),
}));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({
    data: {
      domains: [
        { id: 'seeker', label: 'Seeker', plural_label: 'Seekers' },
        { id: 'provider', label: 'Provider', plural_label: 'Providers' },
      ],
    },
  }),
  DEFAULT_AGGREGATOR_CONFIG: { domains: [{ id: 'seeker', plural_label: 'Seekers' }] },
}));

import OnboardingPage from '@/app/(protected)/onboarding/page';

const ACCOUNT_ID = '7d0f2c1e-4b8a-4c3d-9e2f-1a2b3c4d5e6f';

/** The API's profile read for the acting owner's coordinator account. */
const profile = {
  aggregator_id: ACCOUNT_ID,
  org_slug: 'acme-owner',
  org_name: 'Acme Jobs',
  actor_type: 'aggregator',
  type: 'provider',
  serves: ['provider'],
  url: null,
  contact: { name: 'Asha Rao', phone: '+919800000000', email: 'owner@example.org' },
  locations: [],
  consent: null,
  status: 'active',
  identity: {
    first_name: 'Asha Rao',
    last_name: null,
    email: 'owner@example.org',
    email_verified: true,
    phone: '+919800000000',
    phone_verified: false,
    active: true,
  },
  created_at: '2026-11-19T00:00:00.000Z',
  updated_at: '2026-11-19T00:00:00.000Z',
};

let requested: string[] = [];
const origFetch = globalThis.fetch;

beforeEach(() => {
  requested = [];
  useRegistrationLinks.mockReturnValue({ data: [], isLoading: false });
  globalThis.fetch = vi.fn(async (url: string) => {
    requested.push(url);
    if (url === '/api/aggregator/profile/me') return Response.json(profile);
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('<OnboardingPage /> while acting', () => {
  it("shows the acting banner and the cards for the coordinator account's domain", async () => {
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages}>
          <AuthProvider
            initialUser={{ id: ACCOUNT_ID, name: 'Asha Rao', org: '', email: 'owner@example.org' }}
            acting={{ orgName: 'Acme Jobs' }}
          >
            <OnboardingPage />
          </AuthProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('onboarding-metrics')).toBeInTheDocument();
    expect(screen.getByText(/You're onboarding as yourself in Acme Jobs/)).toBeInTheDocument();
    expect(screen.getByTestId('recent-uploads-body')).toBeInTheDocument();
    expect(screen.getByTestId('your-links-body')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "You don't have access yet" })).toBeNull();
    expect(useRegistrationLinks).toHaveBeenLastCalledWith('provider');
    expect(requested).toContain('/api/aggregator/profile/me');
  });
});
