/**
 * View test: <ProfileCompleteView /> — post-login profile-completion form.
 *
 * `RjsfThemedForm` is shimmed to a deterministic <form> (same pattern as the
 * registration view tests) so these tests exercise the load/save lifecycle
 * (loading → idle → submitting → saved/error), not RJSF's own rendering.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useEffect, type ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import { ThemeModeProvider } from '@/lib/theme-mode';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({
    onSubmit,
    onValidityChange,
    children,
  }: {
    onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
    onValidityChange?: (v: boolean) => void;
    children?: ReactNode;
  }) => {
    useEffect(() => {
      onValidityChange?.(true);
    }, [onValidityChange]);
    return (
      <form
        data-testid="rjsf-shim"
        onSubmit={(ev) => {
          ev.preventDefault();
          onSubmit({ formData: { org_name: 'Acme' } }, ev);
        }}
      >
        {children}
      </form>
    );
  },
}));

import { ProfileCompleteView } from '@/app/(protected)/profile/complete/ProfileCompleteView';

const schema = { title: 'Complete your profile', type: 'object', properties: {} } as never;

function renderView() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ThemeModeProvider>
        <ProfileCompleteView schema={schema} uiSchema={{}} />
      </ThemeModeProvider>
    </NextIntlClientProvider>,
  );
}

describe('<ProfileCompleteView />', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('shows the loading state before the profile GET resolves', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    globalThis.fetch = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    ) as unknown as typeof fetch;

    renderView();
    expect(screen.getByText(messages.profile.complete.loading)).toBeInTheDocument();

    resolveFetch(
      new Response(JSON.stringify({ data: {}, consent: {}, is_complete: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await waitFor(() => expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument());
  });

  it('renders the form once the profile GET resolves successfully', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { org_name: 'Acme' },
            consent: { value: true },
            is_complete: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    renderView();
    expect(await screen.findByTestId('rjsf-shim')).toBeInTheDocument();
  });

  it('falls back to idle (empty form) when the GET response is not ok', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 404 }),
    ) as unknown as typeof fetch;

    renderView();
    expect(await screen.findByTestId('rjsf-shim')).toBeInTheDocument();
  });

  it('shows a load-error message when the GET fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    renderView();
    expect(await screen.findByText('offline')).toBeInTheDocument();
  });

  it('saves successfully via PUT and shows the saved indicator', async () => {
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: {}, consent: {}, is_complete: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderView();
    await screen.findByTestId('rjsf-shim');
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByText(messages.profile.complete.status_saved)).toBeInTheDocument();
  });

  it('shows a save-failed message with the server detail on a non-ok PUT', async () => {
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({ message: 'Validation failed' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: {}, consent: {}, is_complete: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderView();
    await screen.findByTestId('rjsf-shim');
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByText('Validation failed')).toBeInTheDocument();
  });

  it('falls back to a generic save-failed message when the error body has no message', async () => {
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Response('not json', { status: 500 });
      }
      return new Response(JSON.stringify({ data: {}, consent: {}, is_complete: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderView();
    await screen.findByTestId('rjsf-shim');
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByText(/Save failed \(HTTP 500\)/)).toBeInTheDocument();
  });

  it('shows a network-error message when the PUT fetch throws', async () => {
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        throw new Error('connection reset');
      }
      return new Response(JSON.stringify({ data: {}, consent: {}, is_complete: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderView();
    await screen.findByTestId('rjsf-shim');
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByText('connection reset')).toBeInTheDocument();
  });
});
