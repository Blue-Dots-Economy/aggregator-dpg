/**
 * View test: <OrgRegisterForm /> — parent-org registration form (spec §6.1).
 *
 * RJSF is shimmed to a deterministic <form> the same way RegisterView.test.tsx
 * does, so these tests exercise OrgRegisterForm's own submit/error/success
 * logic rather than RJSF's rendering. The consent gate's own scroll-to-unlock
 * mechanics are covered by ConsentGate.test.tsx; here it is shimmed to a plain
 * dialog with an Accept button, for the same reason RJSF is shimmed — these
 * tests exercise OrgRegisterForm's wiring, not the gate's internals.
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// (`useRegistrationFormState`) calls it on every error transition.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

let capturedOnError: ((errs: unknown[]) => void) | undefined;

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({
    onSubmit,
    onError,
    children,
  }: {
    onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
    onError?: (errs: unknown[]) => void;
    children?: ReactNode;
  }) => {
    capturedOnError = onError;
    return (
      <form
        data-testid="rjsf-shim"
        onSubmit={(ev) => {
          ev.preventDefault();
          onSubmit({ formData: { display_name: 'Enable India' } }, ev);
        }}
      >
        {children}
      </form>
    );
  },
}));

let capturedGateProps:
  { open: boolean; onAccept: () => void; onCancel?: () => void; agreeLabel?: string } | undefined;

vi.mock('@/components/consent/ConsentGate', () => ({
  ConsentGate: (props: {
    open: boolean;
    onAccept: () => void;
    onCancel?: () => void;
    agreeLabel?: string;
  }) => {
    capturedGateProps = props;
    if (!props.open) return null;
    return (
      <div role="dialog" aria-label="consent-gate-shim">
        <button type="button" onClick={props.onAccept}>
          Accept (shim)
        </button>
        {props.onCancel ? (
          <button type="button" onClick={props.onCancel}>
            Cancel (shim)
          </button>
        ) : null}
      </div>
    );
  },
}));

import { OrgRegisterForm } from '@/app/(public)/register/OrgRegisterForm';

const orgSchema = {
  title: 'Organisation Registration',
  type: 'object',
  properties: { display_name: { type: 'string', title: 'Display Name' } },
} as never;

const consentContentFixture = {
  terms: { version: 1, title: 'Terms', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy', content: 'Privacy body' },
};

const invite = { token: 'tok-1', email: 'ravi@enable.org', parentName: 'Parent Org' };

function renderForm(props: Record<string, unknown> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgRegisterForm
        schema={orgSchema}
        uiSchema={{}}
        consentContent={consentContentFixture}
        invite={invite}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

/** Submits, then accepts the (shimmed) consent gate. */
async function submitAndAcceptGate() {
  fireEvent.submit(screen.getByTestId('rjsf-shim'));
  await screen.findByRole('dialog');
  act(() => {
    capturedGateProps?.onAccept();
  });
}

describe('<OrgRegisterForm />', () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = window.location;
  const assign = vi.fn();

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    capturedOnError = undefined;
    capturedGateProps = undefined;
    vi.restoreAllMocks();
    assign.mockReset();
  });

  function respond(status: number, body: unknown) {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      calls.push({ url: String(input), body: init?.body ?? '' });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return calls;
  }

  it('names the inviting org the new org registers under', () => {
    renderForm();
    expect(screen.getByText(/Parent Org/)).toBeInTheDocument();
  });

  it('accepts the invite with consent, then goes to sign-in with the invited email', async () => {
    const calls = respond(201, { status: 'pending', login_hint: 'ravi@enable.org' });
    renderForm();
    await submitAndAcceptGate();

    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(calls[0]?.url).toBe('/api/invite/org/accept');
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ display_name: 'Enable India', invite: 'tok-1' });
    expect(body['consent']).toMatchObject({ value: true });
    expect(body).not.toHaveProperty('parent_id');
    expect(assign).toHaveBeenCalledWith(
      '/api/auth/login?returnTo=%2Fconsole&login_hint=ravi%40enable.org',
    );
  });

  it('shows the error banner on a non-2xx response and stays on the page', async () => {
    respond(400, { error: { code: 'INVITE_EMAIL_MISMATCH', title: 'Use the invited email' } });
    renderForm();
    await submitAndAcceptGate();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('explains a full inviting org in plain words', async () => {
    respond(409, { error: { code: 'ORG_DEPTH_LIMIT' } });
    renderForm();
    await submitAndAcceptGate();
    expect(await screen.findByText(messages.register.org_error_depth_limit)).toBeInTheDocument();
  });

  it('shows a network-error banner when fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    renderForm();
    await submitAndAcceptGate();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('leaves field errors to the fields, with no banner', () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    renderForm();
    act(() => {
      capturedOnError?.([{ property: '.display_name', message: 'is required', name: 'required' }]);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('when the consent copy failed to load, submitting shows a visible error and posts nothing', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    renderForm({ consentContent: undefined });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_title)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
