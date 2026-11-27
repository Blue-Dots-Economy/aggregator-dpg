/**
 * View test: <VoiceOrFormView /> — the two-option public registration page.
 *
 * Covers the "Call to register" first screen (fields, labels from the schema,
 * terms checkbox, the bot's number, the form option and the sign-in line), the
 * voice request and the screen after it (new and existing account, the `tel:`
 * button, the move to Signals when the participant comes back), the under-18
 * notice and its countdown, the 409 `VOICE_BOT_UNAVAILABLE` fallback, "Register
 * another", and the full-form path with its Back. RJSF is shimmed as in the
 * `PublicRegistrationView.*.test.tsx` files.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';
import type { ParticipantConsent } from '@/components/consent/consent-types';
import { chooseOption } from '@/__tests__/test-utils';

// jsdom does not implement scrollIntoView; the error banner's focus effect calls it.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({ children }: { children?: React.ReactNode }) => (
    <form data-testid="rjsf-shim">{children}</form>
  ),
}));

const cfgMock = vi.hoisted(() => ({
  value: undefined as Record<string, unknown> | undefined,
  fallback: { brand: { short_name: 'Blue Dots' }, domains: [] },
}));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: cfgMock.value, isError: false }),
  DEFAULT_AGGREGATOR_CONFIG: cfgMock.fallback,
}));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('@/app/[org]/[slug]/SignalsSignInCta', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  navigateToSignals: navigateMock,
}));

// Pull the view after mocks register.
import { VoiceOrFormView } from '@/app/[org]/[slug]/VoiceOrFormView';

const SIGNALS_URL = 'https://signals-seeker.example/auth/login';
const CURRENT_YEAR = new Date().getFullYear();
const ADULT_YEAR = String(CURRENT_YEAR - 30);
const MINOR_YEAR = String(CURRENT_YEAR - 15);

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
    voice_or_form: {
      label_i18n_key: 'x',
      submission_shape: 'account_and_profile',
      public_hint_i18n_key: null,
      signals_cta: true,
    },
  },
  signals_ui_urls: { seeker: SIGNALS_URL },
};

/** A domain that gates on consent and on age, like the UP seeker domain. */
const GATED_DOMAIN = {
  id: 'seeker',
  label: 'Seeker',
  go_live_required: ['consent_required'],
  guardian_consent_required: true,
};

const CONSENT_CONTENT: ParticipantConsent = {
  terms: { version: 1, title: 'Terms of Service', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: 'Privacy body' },
};

const BOT_RESPONSE = {
  display_name: 'UP Rozgar Sahayak',
  phone: '+911234567890',
  languages: ['hi'],
};

const call = messages.profile.public_reg.call;

/** Mocks the voice-request BFF route with one response. */
function mockVoiceRequest(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function renderView(
  opts: {
    consentContent?: ParticipantConsent | null;
    schema?: Record<string, unknown>;
    botDescription?: string;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <VoiceOrFormView
          org="acme"
          slug="winter25"
          network="blue_dot"
          domain="seeker"
          context={{ title: 'Winter 2025 Registration', org_name: 'Acme', district: 'Agra' }}
          schema={opts.schema ?? { type: 'object', properties: { name: { type: 'string' } } }}
          uiSchema={{}}
          identity={{ name: 'name', phone: 'phone', email: 'email' }}
          submissionShape="account_and_profile"
          publicHintI18nKey={null}
          registrationMode="voice_or_form"
          consentContent={opts.consentContent ?? null}
          voiceBot={{
            display_name: 'UP Rozgar Sahayak',
            phone: '+911234567890',
            languages: ['hi'],
            ...(opts.botDescription !== undefined && { description: opts.botDescription }),
          }}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const submitButton = () => screen.queryByRole('button', { name: call.submit });
const formButton = () => screen.getByRole('button', { name: new RegExp(call.form_cta) });

/** Fills name and phone on the call form. */
function fillCallForm() {
  fireEvent.change(screen.getByLabelText(new RegExp(call.name_label)), {
    target: { value: 'Jane Doe' },
  });
  fireEvent.change(screen.getByLabelText(new RegExp(call.phone_label)), {
    target: { value: '9876543210' },
  });
}

/** Fills the form, ticks the terms and submits, for a gated domain. */
async function submitGated(user: ReturnType<typeof userEvent.setup>) {
  fillCallForm();
  await chooseOption(screen.getByLabelText(new RegExp(call.year_of_birth_label)), ADULT_YEAR);
  fireEvent.click(screen.getByRole('checkbox'));
  await user.click(submitButton()!);
}

beforeEach(() => {
  cfgMock.value = CFG;
  navigateMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('<VoiceOrFormView /> first screen', () => {
  it('shows the page header, the call form with the bot number, the form option and the sign-in line', () => {
    renderView();
    expect(screen.getByRole('heading', { name: 'Winter 2025 Registration' })).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: call.title })).toBeInTheDocument();
    expect(screen.getByLabelText(new RegExp(call.name_label))).toBeInTheDocument();
    expect(screen.getByLabelText(new RegExp(call.phone_label))).toBeInTheDocument();
    expect(screen.queryByLabelText(/Email/)).toBeNull();
    const number = screen.getByTestId('bot-number');
    expect(number).toHaveTextContent('+91 12345 67890');
    expect(number).toHaveTextContent('Talk to UP Rozgar Sahayak in Hindi to register.');
    expect(submitButton()).toBeInTheDocument();
    expect(formButton()).toHaveTextContent(call.form_cta_hint);
    expect(screen.getByText('Already registered?')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in with OTP' })).toHaveAttribute(
      'href',
      SIGNALS_URL,
    );
  });

  it('shows the bot description in place of the generated line when one is set', () => {
    renderView({ botDescription: 'Talk to us in Hindi to register your company on BlueDots.' });
    const number = screen.getByTestId('bot-number');
    expect(number).toHaveTextContent('Talk to us in Hindi to register your company on BlueDots.');
    expect(number).not.toHaveTextContent('Talk to UP Rozgar Sahayak');
  });

  it('keeps the generated line when the description is blank', () => {
    renderView({ botDescription: '  ' });
    expect(screen.getByTestId('bot-number')).toHaveTextContent('Talk to UP Rozgar Sahayak');
  });

  it('labels the fields with the schema titles when the schema has them', () => {
    renderView({
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', title: 'Company Name' },
          phone: { type: 'string', title: 'Hiring Manager Phone Number' },
        },
      },
    });
    expect(screen.getByLabelText(/Company Name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Hiring Manager Phone Number/)).toBeInTheDocument();
  });

  it('leaves out the sign-in line when the Signals hand-off is not configured', () => {
    cfgMock.value = { ...CFG, signals_ui_urls: {} };
    renderView();
    expect(screen.queryByRole('link', { name: 'Sign in with OTP' })).toBeNull();
    expect(submitButton()).toBeInTheDocument();
    expect(formButton()).toBeInTheDocument();
  });

  it('asks for the year of birth and the terms only when the domain gates on them', () => {
    renderView();
    expect(screen.queryByLabelText(new RegExp(call.year_of_birth_label))).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('<VoiceOrFormView /> voice request', () => {
  it('posts name and phone, without email, to the voice-request route', async () => {
    const fetchMock = mockVoiceRequest(200, { existing: false, voice_bot: BOT_RESPONSE });
    const user = userEvent.setup();
    renderView();
    fillCallForm();
    await user.click(submitButton()!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/acme/winter25/voice-request');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['name']).toBe('Jane Doe');
    expect(body['phone']).toEqual(expect.stringContaining('9876543210'));
    expect('email' in body).toBe(false);
    expect('consent_terms' in body).toBe(false);
  });

  it('needs the terms box ticked, then sends consent and the birth year', async () => {
    cfgMock.value = { ...CFG, domains: [GATED_DOMAIN] };
    const fetchMock = mockVoiceRequest(200, { existing: false, voice_bot: BOT_RESPONSE });
    const user = userEvent.setup();
    renderView({ consentContent: CONSENT_CONTENT });
    fillCallForm();
    await chooseOption(screen.getByLabelText(new RegExp(call.year_of_birth_label)), ADULT_YEAR);
    await user.click(submitButton()!);
    expect(await screen.findByText(call.terms_required)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox'));
    await user.click(submitButton()!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['consent_terms']).toBe(true);
    expect(body['consent_privacy']).toBe(true);
    expect(body['year_of_birth']).toBe(ADULT_YEAR);
  });

  it('opens the terms and privacy text from the links in the checkbox label', async () => {
    cfgMock.value = { ...CFG, domains: [GATED_DOMAIN] };
    const user = userEvent.setup();
    renderView({ consentContent: CONSENT_CONTENT });
    await user.click(screen.getByRole('button', { name: 'Terms of Service' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows "You\'re all set", the tel: button and Continue to BlueDots for a new account', async () => {
    mockVoiceRequest(200, { existing: false, voice_bot: BOT_RESPONSE });
    const user = userEvent.setup();
    renderView();
    fillCallForm();
    await user.click(submitButton()!);

    expect(await screen.findByText("You're all set")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Call +91 12345 67890' })).toHaveAttribute(
      'href',
      'tel:+911234567890',
    );
    await user.click(screen.getByRole('button', { name: call.continue_to_signals }));
    expect(navigateMock).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('shows "You already have an account" for an existing one', async () => {
    mockVoiceRequest(200, { existing: true, voice_bot: BOT_RESPONSE });
    const user = userEvent.setup();
    renderView();
    fillCallForm();
    await user.click(submitButton()!);

    expect(await screen.findByText('You already have an account')).toBeInTheDocument();
    expect(screen.queryByText("You're all set")).toBeNull();
  });

  it('moves to Signals when the participant comes back to the page after the call', async () => {
    mockVoiceRequest(200, { existing: false, voice_bot: BOT_RESPONSE });
    const user = userEvent.setup();
    renderView();
    fillCallForm();
    await user.click(submitButton()!);
    await screen.findByText("You're all set");

    const setVisibility = (value: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    setVisibility('visible');
    expect(navigateMock).not.toHaveBeenCalled();
    setVisibility('hidden');
    setVisibility('visible');
    expect(navigateMock).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('hides the call form and keeps the form option on 409 VOICE_BOT_UNAVAILABLE', async () => {
    mockVoiceRequest(409, {
      error: { code: 'VOICE_BOT_UNAVAILABLE', title: 'Unavailable', detail: 'No bot.' },
    });
    const user = userEvent.setup();
    renderView();
    fillCallForm();
    await user.click(submitButton()!);

    expect(
      await screen.findByText(
        'The voice assistant is not available right now. Please register with the form.',
      ),
    ).toBeInTheDocument();
    expect(submitButton()).toBeNull();
    expect(screen.queryByTestId('bot-number')).toBeNull();
    expect(formButton()).toBeInTheDocument();
  });

  it('keeps the fields and shows the error banner on any other failure', async () => {
    mockVoiceRequest(500, { error: { code: 'INTERNAL', title: 'x', detail: 'y' } });
    const user = userEvent.setup();
    renderView();
    fillCallForm();
    await user.click(submitButton()!);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(new RegExp(call.name_label))).toHaveValue('Jane Doe');
  });

  it('"Register another" returns to the first screen with empty fields', async () => {
    cfgMock.value = { ...CFG, domains: [GATED_DOMAIN] };
    mockVoiceRequest(200, { existing: false, voice_bot: BOT_RESPONSE });
    const user = userEvent.setup();
    renderView({ consentContent: CONSENT_CONTENT });
    await submitGated(user);
    await screen.findByText("You're all set");

    await user.click(screen.getByRole('button', { name: /register another/i }));
    expect(screen.getByLabelText(new RegExp(call.name_label))).toHaveValue('');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
});

describe('<VoiceOrFormView /> under 18', () => {
  it('hides the number and the call button and shows the notice', async () => {
    cfgMock.value = { ...CFG, domains: [GATED_DOMAIN] };
    renderView({ consentContent: CONSENT_CONTENT });
    await chooseOption(screen.getByLabelText(new RegExp(call.year_of_birth_label)), MINOR_YEAR);

    expect(screen.getByTestId('minor-redirect-notice')).toHaveTextContent("You're under 18");
    expect(submitButton()).toBeNull();
    expect(screen.queryByTestId('bot-number')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('opens the Signals page when the countdown ends', async () => {
    cfgMock.value = { ...CFG, domains: [GATED_DOMAIN] };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderView({ consentContent: CONSENT_CONTENT });
    await chooseOption(screen.getByLabelText(new RegExp(call.year_of_birth_label)), MINOR_YEAR);
    expect(screen.getByTestId('minor-redirect-notice')).toHaveTextContent('Opening in 10 s');
    expect(navigateMock).not.toHaveBeenCalled();

    for (let i = 0; i < 10; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('opens the Signals page at once on "Go now"', async () => {
    cfgMock.value = { ...CFG, domains: [GATED_DOMAIN] };
    const user = userEvent.setup();
    renderView({ consentContent: CONSENT_CONTENT });
    await chooseOption(screen.getByLabelText(new RegExp(call.year_of_birth_label)), MINOR_YEAR);
    await user.click(screen.getByRole('button', { name: 'Go now' }));
    expect(navigateMock).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('removes the notice when the year is changed to an adult one', async () => {
    cfgMock.value = { ...CFG, domains: [GATED_DOMAIN] };
    renderView({ consentContent: CONSENT_CONTENT });
    const year = screen.getByLabelText(new RegExp(call.year_of_birth_label));
    await chooseOption(year, MINOR_YEAR);
    await chooseOption(year, ADULT_YEAR);
    expect(screen.queryByTestId('minor-redirect-notice')).toBeNull();
    expect(submitButton()).toBeInTheDocument();
  });

  it('stays without a countdown when no Signals page is configured', async () => {
    cfgMock.value = { ...CFG, domains: [GATED_DOMAIN], signals_ui_urls: {} };
    renderView({ consentContent: CONSENT_CONTENT });
    await chooseOption(screen.getByLabelText(new RegExp(call.year_of_birth_label)), MINOR_YEAR);
    const notice = screen.getByTestId('minor-redirect-notice');
    expect(notice).toHaveTextContent(messages.profile.public_reg.minor.body_no_link);
    expect(screen.queryByRole('button', { name: 'Go now' })).toBeNull();
  });
});

describe('<VoiceOrFormView /> form path', () => {
  it('opens the full form, and its Back returns to the call screen', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(formButton());
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
    expect(screen.queryByTestId('registration-chooser')).toBeNull();
    expect(screen.queryByTestId('voice-call-screen')).toBeNull();

    await user.click(screen.getByRole('button', { name: /back to options/i }));
    expect(screen.getByTestId('voice-call-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('rjsf-shim')).toBeNull();
  });
});
