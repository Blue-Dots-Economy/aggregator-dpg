/**
 * View test: <PublicRegistrationView /> page header and hero band — brand
 * logo, domain label and the link's event details.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({ children }: { children?: React.ReactNode }) => (
    <form data-testid="rjsf-shim">{children}</form>
  ),
}));

const cfgMock = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: cfgMock.value, isError: false }),
  DEFAULT_AGGREGATOR_CONFIG: { brand: { short_name: 'Default' }, domains: [] },
}));

import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

const BRAND = { short_name: 'Blue Dots', primary_color: '#2563EB' };

beforeEach(() => {
  cfgMock.value = { brand: BRAND, domains: [{ id: 'seeker', label: 'Seeker' }] };
});

function renderView(context: Record<string, unknown>, domain = 'seeker') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <PublicRegistrationView
          org="acme"
          slug="winter25"
          domain={domain}
          context={context}
          schema={{ type: 'object', properties: { name: { type: 'string' } } }}
          uiSchema={{}}
          submissionShape="account_and_profile"
          publicHintI18nKey={null}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('<PublicRegistrationView /> — header and hero', () => {
  it('shows the title, organisation and joined location', () => {
    renderView({
      title: 'Winter Drive',
      org_name: 'Acme',
      district: 'Mysuru',
      state: 'Karnataka',
      event_location: 7,
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Winter Drive');
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Mysuru · Karnataka')).toBeInTheDocument();
    expect(screen.getByText('Seeker')).toBeInTheDocument();
  });

  it('falls back to lever_event, then to "Register", for the title', () => {
    renderView({ title: '', lever_event: 'Job Fair' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Job Fair');
  });

  it('uses "Register" when the context has no title', () => {
    renderView({ title: 3 });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Register');
  });

  it('shows the location without the organisation separator when there is no organisation', () => {
    renderView({ state: 'Goa' });
    expect(screen.getByText('Goa')).toBeInTheDocument();
    expect(screen.queryByText('·')).toBeNull();
  });

  it('falls back to the plural label, then the domain id, for the band label', () => {
    cfgMock.value = { brand: BRAND, domains: [{ id: 'seeker', plural_label: 'Seekers' }] };
    renderView({});
    expect(screen.getByText('Seekers')).toBeInTheDocument();
  });

  it('shows the domain id when the domain is not in the config', () => {
    renderView({}, 'provider');
    expect(screen.getByText('provider')).toBeInTheDocument();
  });

  it('renders the brand logo when the config has one, else the short name', () => {
    cfgMock.value = {
      brand: { ...BRAND, logo: { default: '/logo.png' } },
      domains: [{ id: 'seeker', label: 'Seeker' }],
    };
    renderView({});
    expect(screen.getByRole('img', { name: 'Blue Dots' })).toBeInTheDocument();
  });

  it('shows the brand short name without a logo', () => {
    renderView({});
    expect(screen.getByText('Blue Dots')).toBeInTheDocument();
  });
});
