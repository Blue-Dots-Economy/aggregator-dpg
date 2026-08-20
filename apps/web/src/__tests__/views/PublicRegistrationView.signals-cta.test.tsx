/**
 * View test: the Signals "Already Registered — Sign In" CTA (#652).
 *
 * Covers the two config gates (per-mode `signals_cta`, per-domain
 * `signals_ui_urls`) across both public form surfaces — the full-profile RJSF
 * form and the account-only MinimalIdentityForm. RJSF is mocked to the same
 * thin shim used by PublicRegistrationView.lookup.test.tsx: the CTA is
 * rendered as a child of the form, so the shim must render `children`.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// calls it whenever state transitions to 'error'.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Shim RjsfThemedForm: render a deterministic <form>; reads schema defaults
// for the email/name fields to construct a deterministic formData payload
// for onSubmit. Keeps RJSF's render tree out of the test — we exercise the
// CTA gating, not RJSF rendering (covered by RJSF's own tests).
vi.mock('@/components/forms/RjsfThemed', () => {
  return {
    RjsfThemedForm: ({
      schema,
      onSubmit,
      children,
    }: {
      schema: { properties?: Record<string, { default?: unknown }> };
      onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
      children?: React.ReactNode;
    }) => {
      const formData: Record<string, unknown> = {};
      for (const [field, def] of Object.entries(schema.properties ?? {})) {
        if (def && 'default' in def && def.default !== undefined) {
          formData[field] = def.default;
        }
      }
      return (
        <form
          data-testid="rjsf-shim"
          onSubmit={(ev) => {
            ev.preventDefault();
            onSubmit({ formData }, ev);
          }}
        >
          {children}
        </form>
      );
    },
  };
});

// Config drives the CTA entirely; each test supplies its own payload.
const cfgMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: cfgMock.value }),
  DEFAULT_AGGREGATOR_CONFIG: cfgMock.value,
}));

// Pull the view after mocks register.
import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

const CFG = {
  aggregator: { name: 'Test' },
  brand: {
    short_name: 'Blue Dots',
    long_name: 'Blue Dots',
    url_slug: 'bd',
    primary_color: '#2563EB',
  },
  network: { id: 'blue_dot' },
  domains: [{ id: 'seeker', label: 'Seeker', plural_label: 'Seekers', item_type: 'profile_1.0' }],
  registration_modes: {
    form: {
      label_i18n_key: 'x',
      submission_shape: 'account_and_profile',
      public_hint_i18n_key: null,
      signals_cta: true,
    },
    voice: {
      label_i18n_key: 'y',
      submission_shape: 'account_only',
      public_hint_i18n_key: null,
      signals_cta: false,
    },
  },
  signals_ui_urls: { seeker: 'https://signals-seeker.example/auth/login' },
};

/**
 * Render the public registration view for one link shape. Everything the CTA
 * depends on comes from the mocked config; the props here only select which
 * form surface renders and which mode/domain the link declares.
 */
function renderView(opts: {
  domain: string;
  registrationMode: string | null;
  submissionShape: 'account_only' | 'account_and_profile';
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <PublicRegistrationView
          org="acme"
          slug="winter25"
          network="blue_dot"
          domain={opts.domain}
          context={{ title: 'Winter 2025 Registration', org_name: 'Acme' }}
          schema={{
            type: 'object',
            properties: { email: { type: 'string' }, name: { type: 'string' } },
          }}
          uiSchema={{}}
          identity={{ name: 'name', phone: 'phone', email: 'email' }}
          submissionShape={opts.submissionShape}
          publicHintI18nKey={null}
          registrationMode={opts.registrationMode}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('Signals sign-in CTA', () => {
  it('renders on the full-profile form and opens the domain URL in a new tab', () => {
    cfgMock.value = CFG;
    renderView({
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    const link = screen.getByRole('link', { name: /already registered/i });
    expect(link).toHaveAttribute('href', 'https://signals-seeker.example/auth/login');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('is absent when the mode has signals_cta false', () => {
    cfgMock.value = CFG;
    renderView({ domain: 'seeker', registrationMode: 'voice', submissionShape: 'account_only' });
    expect(screen.queryByRole('link', { name: /already registered/i })).toBeNull();
  });

  it('is absent when the domain has no configured URL', () => {
    cfgMock.value = { ...CFG, signals_ui_urls: {} };
    renderView({
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    expect(screen.queryByRole('link', { name: /already registered/i })).toBeNull();
  });

  it('renders on the account-only form when signals_cta is explicitly enabled for voice', () => {
    cfgMock.value = {
      ...CFG,
      registration_modes: {
        ...CFG.registration_modes,
        voice: { ...CFG.registration_modes.voice, signals_cta: true },
      },
    };
    renderView({ domain: 'seeker', registrationMode: 'voice', submissionShape: 'account_only' });
    expect(screen.getByRole('link', { name: /already registered/i })).toBeInTheDocument();
  });

  it('falls back to the submission shape when the mode is unknown to the config', () => {
    cfgMock.value = CFG;
    renderView({
      domain: 'seeker',
      registrationMode: 'kiosk',
      submissionShape: 'account_and_profile',
    });
    expect(screen.getByRole('link', { name: /already registered/i })).toBeInTheDocument();
  });
});
