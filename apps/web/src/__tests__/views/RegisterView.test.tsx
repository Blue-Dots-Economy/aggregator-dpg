/**
 * View test: <RegisterView /> — org-hierarchy flag behaviour.
 *
 * Covers the three surfaces the flag controls: flag-off single form (no tabs,
 * no org fetch), flag-on tabs + coordinator org selector, the bootstrap
 * empty-org state, and that a selected org is forwarded as `org_id` on submit.
 *
 * RJSF, the shadcn Select, and useAggregatorConfig are shimmed so the test
 * exercises RegisterView's own logic, not third-party rendering.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// calls it whenever state transitions to 'error'.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

let capturedOnError: ((errs: unknown[]) => void) | undefined;
// The schema RegisterView last handed to RJSF — lets consent-gate tests
// assert `stripConsentBlock` actually ran on the real schema, without this
// shim needing to render RJSF's own field widgets.
let capturedSchema: unknown;

// Deterministic RJSF form: renders a submittable <form> plus children (the
// submit button). Fires onSubmit with an empty payload — RegisterView merges
// consent + org_id on top. Also exposes `onError` so tests can simulate a
// client-validation failure the same way RJSF would surface one.
vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({
    schema,
    onSubmit,
    onError,
    children,
  }: {
    schema?: unknown;
    onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
    onError?: (errs: unknown[]) => void;
    children?: ReactNode;
  }) => {
    capturedSchema = schema;
    capturedOnError = onError;
    return (
      <form
        data-testid="rjsf-shim"
        onSubmit={(ev) => {
          ev.preventDefault();
          onSubmit({ formData: { name: 'Coord' } }, ev);
        }}
      >
        {children}
      </form>
    );
  },
}));

// The consent gate's own scroll-to-unlock behaviour is covered by
// ConsentGate.test.tsx. Here it is shimmed to a plain dialog with an Accept /
// Cancel button so these tests exercise RegisterView's wiring (open/close,
// what gets posted on accept) rather than re-driving the scroll mechanics.
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

// Native-select shim for the shadcn Select so onValueChange is fire-able.
vi.mock('@/components/ui/Select', () => ({
  Select: ({
    children,
    onValueChange,
    disabled,
  }: {
    children?: ReactNode;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
  }) => (
    <select
      data-testid="org-select"
      disabled={disabled}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <option value="">{placeholder}</option>
  ),
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

vi.mock('@/hooks/useAggregatorConfig', () => {
  const cfg = { brand: { short_name: 'Test' }, domains: [{ id: 'seeker', label: 'Seeker' }] };
  return {
    useAggregatorConfig: () => ({ data: cfg, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: cfg,
  };
});

import { RegisterView } from '@/app/(public)/register/RegisterView';

const coordSchema = { title: 'Aggregator Registration', type: 'object', properties: {} } as never;
const orgSchema = { title: 'Organisation Registration', type: 'object', properties: {} } as never;

function renderView(props: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <RegisterView schema={coordSchema} uiSchema={{}} {...props} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('RegisterView org hierarchy', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('flag off: renders a single form, no tabs, no org fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderView({ orgHierarchyEnabled: false });

    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByTestId('org-select')).toBeNull();
    // No /api/orgs call when the flag is off.
    const orgCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/orgs'));
    expect(orgCalls).toHaveLength(0);
  });

  it('flag on: shows both tabs and the coordinator org selector', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ orgs: [{ id: 'o1', slug: 's', display_name: 'Enable India' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    ) as unknown as typeof fetch;

    renderView({ orgHierarchyEnabled: true, orgSchema, orgUiSchema: {} });

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(await screen.findByTestId('org-select')).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Enable India' })).toBeInTheDocument();
  });

  it('flag on, zero active orgs: shows the bootstrap empty state, hides the form', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ orgs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    renderView({ orgHierarchyEnabled: true, orgSchema, orgUiSchema: {} });

    expect(await screen.findByText(messages.register.coordinator_no_orgs)).toBeInTheDocument();
    expect(screen.queryByTestId('rjsf-shim')).toBeNull();
  });

  it('flag on: forwards the selected org as org_id on coordinator submit', async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('/api/orgs')) {
        return new Response(
          JSON.stringify({ orgs: [{ id: 'o1', slug: 's', display_name: 'Enable India' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      calls.push({ url, body: init?.body ?? '' });
      return new Response(JSON.stringify({ aggregator_id: 'agg-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderView({ orgHierarchyEnabled: true, orgSchema, orgUiSchema: {} });

    // Wait until the org option is present (list loaded) before selecting, so
    // the native-select value actually resolves to 'o1'.
    await screen.findByRole('option', { name: 'Enable India' });
    const select = await screen.findByTestId('org-select');
    fireEvent.change(select, { target: { value: 'o1' } });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    // Submit now opens the consent gate rather than posting directly; accept
    // it (the shim) to reach the actual POST.
    await screen.findByRole('dialog');
    act(() => {
      capturedGateProps?.onAccept();
    });

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const submitCall = calls.find((c) => c.url.includes('/api/aggregator/register'));
    expect(submitCall).toBeDefined();
    // org_id forwarded, and name inherits the selected org's display name
    // (the free-text Organisation Name field is hidden in the coordinator flow).
    expect(JSON.parse(submitCall!.body)).toMatchObject({ org_id: 'o1', name: 'Enable India' });
  });

  it('flag on: shows the org-selector error state with a working retry', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('boom', { status: 500 });
      return new Response(
        JSON.stringify({ orgs: [{ id: 'o1', slug: 's', display_name: 'Enable India' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    renderView({ orgHierarchyEnabled: true, orgSchema, orgUiSchema: {} });

    expect(await screen.findByText(messages.register.org_selector_error)).toBeInTheDocument();
    fireEvent.click(screen.getByText(messages.register.org_selector_retry));

    expect(await screen.findByTestId('org-select')).toBeInTheDocument();
  });

  it('coordinator form: surfaces a client-validation error via onError', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    renderView({ orgHierarchyEnabled: false });

    act(() => {
      capturedOnError?.([{ property: '.name', message: 'is required', name: 'required' }]);
    });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(messages.register.validation_error_title)).toBeInTheDocument();
  });
});

describe('RegisterView consent gate', () => {
  const schemaWithConsent = {
    type: 'object',
    required: ['name', 'consent'],
    properties: {
      name: { type: 'string' },
      consent: {
        type: 'object',
        title: 'Terms & Privacy Consent',
        required: ['value'],
        properties: { value: { type: 'boolean' } },
      },
    },
  };

  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('coordinator: strips the consent block from the schema handed to RJSF', () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;

    renderView({ orgHierarchyEnabled: false, schema: schemaWithConsent });

    const rendered = capturedSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(rendered.properties).not.toHaveProperty('consent');
    expect(rendered.required).not.toContain('consent');
  });

  it('coordinator: submitting opens the gate and posts nothing', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ aggregator_id: 'agg-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderView({ orgHierarchyEnabled: false });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('coordinator: cancelling the gate closes it without posting, leaving the form in place', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderView({ orgHierarchyEnabled: false });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    act(() => {
      capturedGateProps?.onCancel?.();
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
  });

  it('coordinator: accepting the gate posts consent.value:true with both timestamps to /api/aggregator/register', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchSpy = vi.fn(async (input: unknown, init?: { body?: string }) => {
      calls.push({ url: String(input), body: init?.body ?? '' });
      return new Response(JSON.stringify({ aggregator_id: 'agg-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderView({ orgHierarchyEnabled: false });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
    await screen.findByRole('dialog');

    act(() => {
      capturedGateProps?.onAccept();
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toContain('/api/aggregator/register');
    const body = JSON.parse(calls[0]!.body) as { consent?: Record<string, unknown> };
    expect(body.consent).toMatchObject({ value: true });
    expect(body.consent?.['given_at']).toBeDefined();
    expect(body.consent?.['valid_till']).toBeDefined();
  });

  it('org: strips the consent block from the schema handed to RJSF', () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;

    renderView({
      orgHierarchyEnabled: true,
      orgSchema: schemaWithConsent,
      orgUiSchema: {},
    });
    fireEvent.click(screen.getAllByRole('tab')[1]!);

    const rendered = capturedSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(rendered.properties).not.toHaveProperty('consent');
    expect(rendered.required).not.toContain('consent');
  });

  it('org: submitting opens the gate, posts nothing, then accepting posts consent.value:true with both timestamps to /api/org/register', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchSpy = vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('/api/org/register')) {
        calls.push({ url, body: init?.body ?? '' });
        return new Response(JSON.stringify({ slug: 'acme-org' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderView({ orgHierarchyEnabled: true, orgSchema, orgUiSchema: {} });
    fireEvent.click(screen.getAllByRole('tab')[1]!);
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(calls).toHaveLength(0);

    act(() => {
      capturedGateProps?.onAccept();
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    const body = JSON.parse(calls[0]!.body) as { consent?: Record<string, unknown> };
    expect(body.consent).toMatchObject({ value: true });
    expect(body.consent?.['given_at']).toBeDefined();
    expect(body.consent?.['valid_till']).toBeDefined();
  });
});
