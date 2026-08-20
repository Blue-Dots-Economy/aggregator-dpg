/**
 * View test: the post-submit hand-off to the Signals UI (#635).
 *
 * Covers the countdown that runs on the success panel, the immediate
 * `Continue to Signals` button, the `Register another` cancel (a field
 * operator registering people back-to-back must not be thrown out of the
 * form), the dedup-hit outcome, and the unconfigured-domain no-op.
 *
 * Reuses the RJSF shim, render helper and config mock from
 * PublicRegistrationView.signals-cta.test.tsx — the same two config gates
 * decide whether this hand-off is armed at all.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// calls it whenever state transitions to 'error'.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Shim RjsfThemedForm exactly as the CTA test does: a deterministic <form>
// whose submit fires the view's real handleSubmit pipeline. The schema here
// declares no defaults, so formData is `{}` — the identity probe short-
// circuits to "allow" without a lookup fetch, leaving the submit POST as the
// only network call the view makes.
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

// Config drives the hand-off entirely; each test supplies its own payload.
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

const SIGNALS_URL = 'https://signals-seeker.example/auth/login';

/**
 * Render the public registration view for one link shape. Everything the
 * hand-off depends on comes from the mocked config; the props here only
 * select which form surface renders and which mode/domain the link declares.
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

/**
 * Render the view, stub the submit POST, and drive one submit to completion
 * so the green success panel is on screen.
 *
 * @param opts.status - HTTP status the stubbed submit returns (409 for a
 *   dedup hit, which the view treats as a success outcome, not an error).
 * @param opts.outcome - `passed` (new registration) or `skipped` (dedup hit).
 */
async function submitSuccessfully(opts: {
  domain: string;
  registrationMode: string | null;
  submissionShape?: 'account_only' | 'account_and_profile';
  status?: number;
  outcome?: 'passed' | 'skipped';
}): Promise<void> {
  const status = opts.status ?? 200;
  const outcome = opts.outcome ?? 'passed';
  fetchMock.mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => ({ submission_id: 'SUB-0001', outcome }),
  } as unknown as Response);
  renderView({
    domain: opts.domain,
    registrationMode: opts.registrationMode,
    submissionShape: opts.submissionShape ?? 'account_and_profile',
  });
  await act(async () => {
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
  });
}

/**
 * Advance the fake clock by whole seconds, one second per `act` flush.
 *
 * The countdown re-arms its `setTimeout` from an effect, so the next tick's
 * timer does not exist until React has rendered the previous one. A single
 * `advanceTimersByTime(3000)` would therefore fire exactly one tick; each
 * second needs its own flush.
 */
async function tick(seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
  }
}

const assign = vi.fn();
const fetchMock = vi.fn();
let originalLocation: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  assign.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
});

describe('Signals post-submit redirect', () => {
  it('counts down from 3 and then navigates to the domain URL', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    expect(screen.getByText(/Redirecting to Signals in 3/)).toBeInTheDocument();
    await tick(1);
    expect(screen.getByText(/Redirecting to Signals in 2/)).toBeInTheDocument();
    await tick(1);
    expect(screen.getByText(/Redirecting to Signals in 1/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    await tick(1);
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('navigates immediately when Continue to Signals is clicked', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    fireEvent.click(screen.getByRole('button', { name: /continue to signals/i }));
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('cancels the countdown when Register another is clicked', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    fireEvent.click(screen.getByRole('button', { name: /register another/i }));
    await tick(5);
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByText(/Redirecting to Signals/)).toBeNull();
    // The form is back, so the operator can key in the next person.
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
  });

  it('redirects on a dedup hit (outcome=skipped) too', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({
      domain: 'seeker',
      registrationMode: 'form',
      status: 409,
      outcome: 'skipped',
    });
    expect(screen.getByText(/Redirecting to Signals in 3/)).toBeInTheDocument();
    await tick(3);
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('keeps the plain success panel when the domain has no configured URL', async () => {
    cfgMock.value = { ...CFG, signals_ui_urls: {} };
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    // The success panel itself still renders — only the hand-off is absent.
    expect(screen.getByRole('button', { name: /register another/i })).toBeInTheDocument();
    expect(screen.queryByText(/Redirecting to Signals/)).toBeNull();
    expect(screen.queryByRole('button', { name: /continue to signals/i })).toBeNull();
    await tick(5);
    expect(assign).not.toHaveBeenCalled();
  });
});
