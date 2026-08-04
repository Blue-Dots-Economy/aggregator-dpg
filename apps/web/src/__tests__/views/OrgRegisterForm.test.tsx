/**
 * View test: <OrgRegisterForm /> — parent-org registration form (spec §6.1).
 *
 * RJSF is shimmed to a deterministic <form> the same way RegisterView.test.tsx
 * does, so these tests exercise OrgRegisterForm's own submit/error/success
 * logic rather than RJSF's rendering.
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

import { OrgRegisterForm } from '@/app/(public)/register/OrgRegisterForm';

const orgSchema = {
  title: 'Organisation Registration',
  type: 'object',
  properties: { display_name: { type: 'string', title: 'Display Name' } },
} as never;

function renderForm(props: Record<string, unknown> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgRegisterForm schema={orgSchema} uiSchema={{}} {...props} />
    </NextIntlClientProvider>,
  );
}

describe('<OrgRegisterForm />', () => {
  let originalFetch: typeof fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    capturedOnError = undefined;
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
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url).toBe('/api/org/register');
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['display_name']).toBe('Enable India');
    expect(body['consent']).toBeDefined();

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
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

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
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

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
    renderForm();
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
  });
});
