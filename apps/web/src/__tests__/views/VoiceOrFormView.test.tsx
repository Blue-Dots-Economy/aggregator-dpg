/**
 * View test: <VoiceOrFormView /> — the two-option public registration page.
 *
 * Covers the first screen (voice, form and sign-in buttons), the voice form
 * (name and phone, no email), the voice result (new and existing account, the
 * `tel:` button), the 409 `VOICE_BOT_UNAVAILABLE` fallback, the full-form path
 * with its Back, and "Register another". RJSF and the consent gate are shimmed
 * as in the `PublicRegistrationView.*.test.tsx` files.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';
import type { ParticipantConsent } from '@/components/consent/consent-types';

// jsdom does not implement scrollIntoView; the error banner's focus effect calls it.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({ children }: { children?: React.ReactNode }) => (
    <form data-testid="rjsf-shim">{children}</form>
  ),
}));

let capturedGateProps: { open: boolean; onAccept: () => void } | undefined;
vi.mock('@/components/consent/ConsentGate', () => ({
  ConsentGate: (props: { open: boolean; onAccept: () => void }) => {
    capturedGateProps = props;
    return props.open ? <div role="dialog" aria-label="consent-gate-shim" /> : null;
  },
}));

const cfgMock = vi.hoisted(() => ({
  value: undefined as Record<string, unknown> | undefined,
  fallback: { brand: { short_name: 'Blue Dots' }, domains: [] },
}));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: cfgMock.value, isError: false }),
  DEFAULT_AGGREGATOR_CONFIG: cfgMock.fallback,
}));

// Pull the view after mocks register.
import { VoiceOrFormView } from '@/app/[org]/[slug]/VoiceOrFormView';

const SIGNALS_URL = 'https://signals-seeker.example/auth/login';

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

const CONSENT_CONTENT: ParticipantConsent = {
  terms: { version: 1, title: 'Terms of Service', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: 'Privacy body' },
  profileCreation: { version: 1, statement: 'We will use your data to build a profile.' },
};

const BOT_RESPONSE = {
  display_name: 'UP Rozgar Sahayak',
  phone: '+911234567890',
  languages: ['hi'],
};

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

function renderView(consentContent: ParticipantConsent | null = null) {
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
          context={{ title: 'Winter 2025 Registration', org_name: 'Acme' }}
          schema={{ type: 'object', properties: { name: { type: 'string' } } }}
          uiSchema={{}}
          identity={{ name: 'name', phone: 'phone', email: 'email' }}
          submissionShape="account_and_profile"
          publicHintI18nKey={null}
          registrationMode="voice_or_form"
          consentContent={consentContent}
          voiceBot={{ display_name: 'UP Rozgar Sahayak', languages: ['hi'] }}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const voiceButton = () => screen.queryByRole('button', { name: /talk to the voice assistant/i });
const formButton = () => screen.getByRole('button', { name: /register with the form/i });

/** Opens the voice form and fills name and phone. */
async function fillVoiceForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(voiceButton()!);
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } });
  fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
}

beforeEach(() => {
  cfgMock.value = CFG;
  capturedGateProps = undefined;
});

describe('<VoiceOrFormView /> first screen', () => {
  it('shows voice, form and sign-in in that order, the voice one naming the bot and languages', () => {
    renderView();
    const chooser = screen.getByTestId('voice-chooser');
    expect(within(chooser).getByText('How would you like to register?')).toBeInTheDocument();
    const actions = Array.from(chooser.querySelectorAll('button, a'));
    expect(actions).toHaveLength(3);
    expect(actions[0]).toHaveTextContent('Talk to the voice assistant');
    expect(actions[0]).toHaveTextContent('UP Rozgar Sahayak · Hindi');
    expect(actions[1]).toHaveTextContent('Register with the form');
    expect(actions[2]).toHaveAttribute('href', SIGNALS_URL);
  });

  it('leaves out the sign-in button when the Signals hand-off is not configured', () => {
    cfgMock.value = { ...CFG, signals_ui_urls: {} };
    renderView();
    expect(screen.queryByRole('link', { name: /already registered/i })).toBeNull();
    expect(voiceButton()).toBeInTheDocument();
    expect(formButton()).toBeInTheDocument();
  });
});

describe('<VoiceOrFormView /> voice flow', () => {
  it('asks for name and phone only, and Back returns to the first screen', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(voiceButton()!);
    expect(screen.getByText('Give your name and number, then call us.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Phone/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Email/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /back to options/i }));
    expect(screen.getByTestId('voice-chooser')).toBeInTheDocument();
  });

  it('posts name and phone, without email, to the voice-request route', async () => {
    const fetchMock = mockVoiceRequest(200, { existing: false, voice_bot: BOT_RESPONSE });
    const user = userEvent.setup();
    renderView();
    await fillVoiceForm(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/acme/winter25/voice-request');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['name']).toBe('Jane Doe');
    expect(body['phone']).toEqual(expect.stringContaining('9876543210'));
    expect('email' in body).toBe(false);
  });

  it('shows "You\'re all set" and a tel: button for a new account', async () => {
    mockVoiceRequest(200, { existing: false, voice_bot: BOT_RESPONSE });
    const user = userEvent.setup();
    renderView();
    await fillVoiceForm(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText("You're all set")).toBeInTheDocument();
    expect(
      screen.getByText('Call UP Rozgar Sahayak to build your profile. It speaks Hindi.'),
    ).toBeInTheDocument();
    const call = screen.getByRole('link', { name: 'Call +91 12345 67890' });
    expect(call).toHaveAttribute('href', 'tel:+911234567890');
  });

  it('shows "You already have an account" and the same tel: button for an existing one', async () => {
    mockVoiceRequest(200, { existing: true, voice_bot: BOT_RESPONSE });
    const user = userEvent.setup();
    renderView();
    await fillVoiceForm(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('You already have an account')).toBeInTheDocument();
    expect(screen.queryByText("You're all set")).toBeNull();
    expect(screen.getByRole('link', { name: 'Call +91 12345 67890' })).toHaveAttribute(
      'href',
      'tel:+911234567890',
    );
  });

  it('returns to the first screen without the voice button on 409 VOICE_BOT_UNAVAILABLE', async () => {
    mockVoiceRequest(409, {
      error: { code: 'VOICE_BOT_UNAVAILABLE', title: 'Unavailable', detail: 'No bot.' },
    });
    const user = userEvent.setup();
    renderView();
    await fillVoiceForm(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByText(
        'The voice assistant is not available right now. Please register with the form.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('voice-chooser')).toBeInTheDocument();
    expect(voiceButton()).toBeNull();
    expect(formButton()).toBeInTheDocument();
  });

  it('keeps the form and shows the error banner on any other failure', async () => {
    mockVoiceRequest(500, { error: { code: 'INTERNAL', title: 'x', detail: 'y' } });
    const user = userEvent.setup();
    renderView();
    await fillVoiceForm(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/)).toHaveValue('Jane Doe');
  });

  it('opens the consent gate and sends consent_terms and consent_privacy on accept', async () => {
    cfgMock.value = {
      ...CFG,
      domains: [{ id: 'seeker', label: 'Seeker', go_live_required: ['consent_required'] }],
    };
    const fetchMock = mockVoiceRequest(200, { existing: false, voice_bot: BOT_RESPONSE });
    const user = userEvent.setup();
    renderView(CONSENT_CONTENT);
    await fillVoiceForm(user);
    fireEvent.click(screen.getByRole('checkbox', { name: /permit the aggregator/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(capturedGateProps?.open).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => capturedGateProps!.onAccept());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['consent_terms']).toBe(true);
    expect(body['consent_privacy']).toBe(true);
    expect('consent_profile' in body).toBe(false);
  });

  it('Back clears accepted consent and server errors for the next person', async () => {
    cfgMock.value = {
      ...CFG,
      domains: [{ id: 'seeker', label: 'Seeker', go_live_required: ['consent_required'] }],
    };
    const fetchMock = mockVoiceRequest(400, {
      error: { code: 'INVALID_PHONE', title: 'Invalid', detail: 'Bad phone.' },
    });
    const phoneError = messages.profile.public_reg.error_phone_invalid;
    const user = userEvent.setup();
    renderView(CONSENT_CONTENT);
    await fillVoiceForm(user);
    fireEvent.click(screen.getByRole('checkbox', { name: /permit the aggregator/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(capturedGateProps?.open).toBe(true));
    act(() => capturedGateProps!.onAccept());
    expect(await screen.findByText(phoneError)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /back to options/i }));
    await fillVoiceForm(user);
    expect(screen.queryByText(phoneError)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /permit the aggregator/i }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(capturedGateProps?.open).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('"Register another" returns to the first screen with empty fields', async () => {
    mockVoiceRequest(200, { existing: false, voice_bot: BOT_RESPONSE });
    const user = userEvent.setup();
    renderView();
    await fillVoiceForm(user);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText("You're all set");

    await user.click(screen.getByRole('button', { name: /register another/i }));
    expect(screen.getByTestId('voice-chooser')).toBeInTheDocument();
    await user.click(voiceButton()!);
    expect(screen.getByLabelText(/Name/)).toHaveValue('');
  });
});

describe('<VoiceOrFormView /> form path', () => {
  it('opens the full form without the inner chooser, and its Back returns to the first screen', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(formButton());
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
    expect(screen.queryByTestId('registration-chooser')).toBeNull();
    expect(screen.queryByTestId('voice-chooser')).toBeNull();

    await user.click(screen.getByRole('button', { name: /back to options/i }));
    expect(screen.getByTestId('voice-chooser')).toBeInTheDocument();
    expect(screen.queryByTestId('rjsf-shim')).toBeNull();
  });
});
