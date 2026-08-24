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
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
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

// Present in most tests so the gate has something to show; the
// "consent copy unavailable" test overrides it back to `undefined`.
const consentContentFixture = {
  terms: { version: 1, title: 'Terms', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy', content: 'Privacy body' },
};

function renderForm(props: Record<string, unknown> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgRegisterForm
        schema={orgSchema}
        uiSchema={{}}
        consentContent={consentContentFixture}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

/** Opens via submit, then accepts the (shimmed) gate. */
async function submitAndAcceptGate() {
  fireEvent.submit(screen.getByTestId('rjsf-shim'));
  await screen.findByRole('dialog');
  act(() => {
    capturedGateProps?.onAccept();
  });
}

describe('<OrgRegisterForm />', () => {
  let originalFetch: typeof fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    capturedOnError = undefined;
    capturedGateProps = undefined;
    vi.restoreAllMocks();
  });

  it('submits to /api/org/register and shows the success panel with the slug', async () => {
    originalFetch = globalThis.fetch;
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      calls.push({ url: String(input), body: init?.body ?? '' });
      return new Response(JSON.stringify({ slug: 'enable-india-ab12' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderForm();
    await submitAndAcceptGate();

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url).toBe('/api/org/register');
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['display_name']).toBe('Enable India');
    expect(body['consent']).toMatchObject({ value: true });

    expect(await screen.findByText('enable-india-ab12')).toBeInTheDocument();
    expect(screen.getByText(messages.register.org_success_heading)).toBeInTheDocument();
  });

  it('shows the error banner on a non-2xx response', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { title: 'Duplicate', detail: 'Org already exists' } }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    renderForm();
    await submitAndAcceptGate();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Duplicate')).toBeInTheDocument();
    expect(screen.getByText('Org already exists')).toBeInTheDocument();
  });

  it('shows a network-error banner when fetch throws', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    renderForm();
    await submitAndAcceptGate();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Network error')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('surfaces client-side validation errors via onError', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    renderForm();

    // RjsfThemedForm shim captured onError — invoke it directly to simulate
    // RJSF surfacing a client-validation failure before submit fires.
    act(() => {
      capturedOnError?.([{ property: '.display_name', message: 'is required', name: 'required' }]);
    });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(messages.register.validation_error_title)).toBeInTheDocument();
  });

  it('passes consentContent through formContext without crashing when omitted', () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    renderForm({ consentContent: undefined });
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
  });

  it('when the consent copy failed to load, submitting shows a visible error and posts nothing', async () => {
    originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // `consentContent: undefined` mirrors loadConsentConfig failing at boot —
    // `toConsentDocs(undefined)` returns `[]`, so the gate would have nothing
    // to show. Without the fix this is a dead Submit button: no gate, no
    // error, no way for the user to tell what happened.
    renderForm({ consentContent: undefined });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_title)).toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_detail)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
