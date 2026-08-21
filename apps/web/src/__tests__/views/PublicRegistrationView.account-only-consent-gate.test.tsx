/**
 * View test: <PublicRegistrationView /> — the blocking consent gate wired
 * into the `submission_shape === 'account_only'` (MinimalIdentityForm)
 * submit pipeline (#636 Task 8).
 *
 * Structural coverage only (gate opens / does not open, document count,
 * the surviving call-permission checkbox). The accept → resubmit round trip
 * that proves the consent-recording bug fix lives in
 * `PublicRegistrationView.account-only-consent-submit.test.tsx`, which mocks
 * `ConsentGate` the same way `PublicRegistrationView.lookup.test.tsx` does —
 * jsdom never lays out the real gate's scrollable reader, so its checkbox
 * cannot be unlocked without stubbing scroll geometry (see
 * `read-progress.ts`'s "unmeasured is not evidence of anything" guard).
 *
 * `ConsentGate` itself is NOT mocked here (unlike that sibling file): the
 * tracker-node assertions need the real gate, the same way
 * `PublicRegistrationView.consent-gate.test.tsx` covers the full-profile
 * surface.
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

// ResizeObserver is stubbed globally in src/__tests__/setup.ts.

// Config drives showConsent via the domain's go_live_required — same shape as
// PublicRegistrationView.consent-gate.test.tsx. No guardian_consent_required
// here except where a test opts in explicitly: the account-only + consent-gate
// interaction doesn't otherwise need the birth-year field.
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
  // Present on the copy the aggregator loads (a real ParticipantConsent
  // always carries all three documents), but the account-only gate must
  // exclude it — see "excludes the profile document" below.
  profileCreation: { version: 1, statement: 'We will use your data to build a profile.' },
};

interface RenderOpts {
  showConsent: boolean;
  birthYear?: number;
  consentContent?: ParticipantConsent | null;
}

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
          schema={{ type: 'object', properties: {} }}
          uiSchema={{}}
          identity={{ name: 'name', phone: 'phone', email: 'email' }}
          submissionShape="account_only"
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

/** Fills the minimum required identity fields and ticks the call-permission checkbox. */
function fillAndTickCallConsent() {
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } });
  fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /permit the aggregator/i }));
}

describe('<PublicRegistrationView /> account-only consent gate', () => {
  it('opens the gate on submit', async () => {
    renderView({ showConsent: true });
    fillAndTickCallConsent();
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows exactly two tracker nodes — privacy and terms — and excludes the profile document', async () => {
    renderView({ showConsent: true });
    fillAndTickCallConsent();
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await screen.findByRole('dialog');
    expect(screen.getByTestId('consent-node-privacy')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-terms')).toBeInTheDocument();
    expect(screen.queryByTestId('consent-node-profile')).not.toBeInTheDocument();
  });

  it('keeps the call-permission checkbox and still blocks submit when it is unticked', () => {
    renderView({ showConsent: true });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    expect(
      screen.getByRole('checkbox', { name: /permit the aggregator to trigger the call/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
  });

  it('never opens the gate for a minor', async () => {
    renderView({ showConsent: true, birthYear: new Date().getFullYear() - 15 });
    // No consent checkbox at all for a minor — the U18 notice replaces it,
    // so the identity fields alone satisfy validity.
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Kid' } });
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit/i }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never opens the gate when the domain does not require consent', async () => {
    renderView({ showConsent: false });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit/i }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a visible error instead of a dead submit when consent copy failed to load', async () => {
    renderView({ showConsent: true, consentContent: null });
    fillAndTickCallConsent();
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_title)).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_detail)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
