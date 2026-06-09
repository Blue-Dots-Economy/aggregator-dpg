/**
 * View test: <PublicRegistrationView /> — pre-submit lookup branches.
 *
 * RJSF is mocked to a thin shim that exposes its `onSubmit` via a button
 * so each test can fire a submit with whatever form data it wants. The
 * goal here is to exercise the probe → branch → submit pipeline, not the
 * RJSF rendering surface (covered by RJSF's own tests).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';

// Shim RjsfThemedForm: render a deterministic <form>; reads schema defaults
// for the email/name fields to construct a deterministic formData payload
// for onSubmit. Keeps RJSF's render tree out of the test — we exercise the
// lookup/submit pipeline, not RJSF rendering (covered by RJSF's own tests).
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

// useAggregatorConfig hits the BFF. We don't need its real behaviour here.
// vi.mock factories are hoisted — keep defaults inline (no shared const).
vi.mock('@/hooks/useAggregatorConfig', () => {
  const cfg = {
    brand: { short_name: 'Test', primary_color: '#4338ca' },
    domains: [{ id: 'seeker', label: 'Seeker' }],
  };
  return {
    useAggregatorConfig: () => ({ data: cfg, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: cfg,
  };
});

// Pull the view after mocks register.
import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

const baseProps = {
  org: 'acme',
  slug: 'winter25',
  network: 'blue_dot',
  domain: 'seeker',
  context: { title: 'Winter 2025 Registration', org_name: 'Acme' },
  schema: {
    type: 'object' as const,
    properties: {
      email: { type: 'string' as const },
      name: { type: 'string' as const },
    },
  },
  uiSchema: {},
  submissionShape: 'account_and_profile' as const,
  publicHintI18nKey: null,
};

function renderView(formData: Record<string, unknown> = { email: 'a@b.com', name: 'A' }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <PreloadedView initialData={formData} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

// Wrapper that seeds the view's formData via the schema-injected email
// default. Cleaner than reaching inside the component under test.
function PreloadedView({ initialData }: { initialData: Record<string, unknown> }) {
  const schemaWithDefault = {
    ...baseProps.schema,
    properties: {
      ...baseProps.schema.properties,
      email: { ...baseProps.schema.properties.email, default: initialData['email'] },
      name: { ...baseProps.schema.properties.name, default: initialData['name'] },
    },
  };
  return <PublicRegistrationView {...baseProps} schema={schemaWithDefault} />;
}

describe('<PublicRegistrationView /> — lookup branches', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('shows the owned-elsewhere banner and skips the submit', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: true, owned_elsewhere: true, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    expect(await screen.findByTestId('lookup-owned-elsewhere')).toBeInTheDocument();
    // Only the probe — no submit POST followed it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]!.toString()).toContain('/lookup');
  });

  it('shows the resume prompt for an in-progress draft', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({
            user_exists: true,
            owned_elsewhere: false,
            lifecycle_summary: {
              primary_item: {
                item_id: 'item-xyz',
                lifecycle_status: 'draft',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    const banner = await screen.findByTestId('lookup-resume');
    expect(banner).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes through to /submit when the probe says allow', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/submit')) {
        return new Response(JSON.stringify({ outcome: 'passed', submission_id: 'sub-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock.mock.calls[0]![0]!.toString()).toContain('/lookup');
    expect(fetchMock.mock.calls[1]![0]!.toString()).toContain('/submit');
    expect(
      await screen.findByText(/Registration received|Already registered/i),
    ).toBeInTheDocument();
  });

  it('renders no partial checkbox (flag removed; full form always submits)', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ outcome: 'passed', submission_id: 'sub-2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderView();
    expect(screen.queryByTestId('lookup-partial-checkbox')).toBeNull();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const submitCall = fetchMock.mock.calls[1]!;
    const body = JSON.parse(String((submitCall[1] as RequestInit).body)) as {
      partial?: boolean;
      email?: string;
    };
    expect(body.partial).toBeUndefined();
    expect(body.email).toBe('a@b.com');
  });

  it('omits `partial` from the /submit body', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ outcome: 'passed', submission_id: 's' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderView();
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const submitCall = fetchMock.mock.calls[1]!;
    const body = JSON.parse(String((submitCall[1] as RequestInit).body)) as {
      partial?: boolean;
    };
    expect(body.partial).toBeUndefined();
  });

  it('probes using the network identity field-map (non-standard phone key)', async () => {
    // Regression: purple_dot-style networks key phone as `mobile_number`,
    // not `phone`. The probe must read the value via the `identity.phone`
    // selector and forward it as `phone_number`, else owned_elsewhere no-ops.
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input.toString();
      if (url.includes('/lookup')) {
        return new Response(
          JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ outcome: 'passed', submission_id: 's' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const schema = {
      type: 'object' as const,
      properties: { mobile_number: { type: 'string' as const, default: '+919800000000' } },
    };
    render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
          <PublicRegistrationView
            {...baseProps}
            schema={schema}
            identity={{ name: 'name', phone: 'mobile_number', email: 'email' }}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const lookupUrl = fetchMock.mock.calls[0]![0]!.toString();
    expect(lookupUrl).toContain('/lookup');
    expect(lookupUrl).toContain('phone_number=%2B919800000000');
  });
});
