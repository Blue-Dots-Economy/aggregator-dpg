/**
 * View test: <PublicRegistrationView /> — the blocking consent gate wired
 * into the public QR-form submit pipeline (#636 Task 7).
 *
 * RJSF is mocked to the same thin shim `PublicRegistrationView.lookup.test.tsx`
 * and `.signals-cta.test.tsx` use: a deterministic `<form>` whose `onSubmit`
 * is wired straight to the real handler, tagged with a testid so a submit can
 * be fired without depending on RJSF's own validity plumbing. `ConsentGate`
 * itself is NOT mocked — its own scroll-to-unlock mechanics are covered by
 * `ConsentGate.test.tsx`; here we only need the dialog and its tracker nodes
 * to prove the three documents actually reach it.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';
import type { ParticipantConsent } from '@/components/consent/consent-types';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// calls it whenever state transitions to 'error'.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Shim RjsfThemedForm exactly as PublicRegistrationView.signals-cta.test.tsx
// does: a deterministic <form> tagged with a testid, onSubmit wired straight
// through. Keeps RJSF's render tree out of the test — we exercise the gate
// wiring, not RJSF rendering.
vi.mock('@/components/forms/RjsfThemed', () => {
  return {
    RjsfThemedForm: ({
      onSubmit,
      children,
    }: {
      onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
      children?: React.ReactNode;
    }) => (
      <form
        data-testid="rjsf-shim"
        onSubmit={(ev) => {
          ev.preventDefault();
          onSubmit({ formData: {} }, ev);
        }}
      >
        {children}
      </form>
    ),
  };
});

// Config drives showConsent/showBirthYear via the domain's go_live_required /
// guardian_consent_required — same shape as PublicRegistrationView.lookup.test.tsx.
const cfgMock = vi.hoisted(() => ({
  value: undefined as Record<string, unknown> | undefined,
  fallback: { brand: { short_name: 'Blue Dots' }, domains: [] },
}));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: cfgMock.value, isError: false }),
  DEFAULT_AGGREGATOR_CONFIG: cfgMock.fallback,
}));

// Pull the view after mocks register.
import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

const CONSENT_CONTENT: ParticipantConsent = {
  terms: { version: 1, title: 'Terms of Service', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: 'Privacy body' },
  profileCreation: { version: 1, statement: 'We will use your data to build a profile.' },
};

interface RenderOpts {
  showConsent: boolean;
  birthYear?: number;
  consentContent?: ParticipantConsent | null;
}

/**
 * Renders the public registration view with a domain config that drives
 * showConsent/showBirthYear the way `registration-gates.ts` expects, and
 * (when `birthYear` is given) types it into the Year-of-birth select so the
 * view's own `isMinor` derivation reflects it before the submit fires.
 */
function renderView(opts: RenderOpts) {
  const domain: Record<string, unknown> = { id: 'seeker', label: 'Seeker' };
  if (opts.showConsent) domain['go_live_required'] = ['schema_required', 'consent_required'];
  if (opts.birthYear !== undefined) domain['guardian_consent_required'] = true;

  cfgMock.value = {
    brand: { short_name: 'Blue Dots', primary_color: '#2563EB' },
    domains: [domain],
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <PublicRegistrationView
          org="acme"
          slug="winter25"
          domain="seeker"
          context={{ title: 'Winter 2025 Registration', org_name: 'Acme' }}
          schema={{
            type: 'object',
            properties: { email: { type: 'string' }, name: { type: 'string' } },
          }}
          uiSchema={{}}
          identity={{ name: 'name', phone: 'phone', email: 'email' }}
          submissionShape="account_and_profile"
          publicHintI18nKey={null}
          consentContent={opts.consentContent === undefined ? CONSENT_CONTENT : opts.consentContent}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

  if (opts.birthYear !== undefined) {
    fireEvent.change(screen.getByLabelText(/Year of birth/), {
      target: { value: String(opts.birthYear) },
    });
  }

  return result;
}

// ResizeObserver is stubbed globally in src/__tests__/setup.ts.

describe('<PublicRegistrationView /> consent gate', () => {
  it('renders no inline consent checkbox on the form', () => {
    renderView({ showConsent: true });
    expect(screen.queryByRole('checkbox', { name: /consent/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('opens the gate with all three documents when submitting without consent', async () => {
    renderView({ showConsent: true });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-privacy')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-terms')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-profile')).toBeInTheDocument();
  });

  it('never opens the gate for a minor', async () => {
    renderView({ showConsent: true, birthYear: new Date().getFullYear() - 15 });
    expect(screen.getByText(messages.profile.public_reg.u18_notice)).toBeInTheDocument();
    // The probe short-circuits synchronously when `network` is unset, but
    // still resolves through a promise chain that updates state — flush it
    // inside `act` so the assertion sees the settled DOM, not a warning.
    await act(async () => {
      fireEvent.submit(screen.getByTestId('rjsf-shim'));
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never opens the gate when the domain does not require consent', async () => {
    renderView({ showConsent: false });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('rjsf-shim'));
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a visible error instead of a dead submit when consent copy failed to load', async () => {
    renderView({ showConsent: true, consentContent: null });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_title)).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_detail)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
