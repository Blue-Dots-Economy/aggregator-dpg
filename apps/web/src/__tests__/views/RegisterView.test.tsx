/**
 * View test: <RegisterView /> — coordinator registration + org-selector flag.
 *
 * As of #619 the org (owner) registration tab is gone from the public page, so
 * this view is always the single coordinator flow. The `orgHierarchyEnabled`
 * flag now only toggles the coordinator's parent-org selector — never a tab.
 * Covers: flag-off single form (no tabs, no org fetch, no selector), flag-on
 * selector (still no tabs), the bootstrap empty-org state, org_id forwarding on
 * submit, the selector error+retry, and a client-validation error.
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

// Deterministic RJSF form: renders a submittable <form> plus children (the
// submit button). Fires onSubmit with an empty payload — RegisterView merges
// consent + org_id on top. Also exposes `onError` so tests can simulate a
// client-validation failure the same way RJSF would surface one.
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
          onSubmit({ formData: { name: 'Coord' } }, ev);
        }}
      >
        {children}
      </form>
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

describe('RegisterView', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('flag off: renders a single form, no tabs, no selector, no org fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderView({ orgHierarchyEnabled: false });

    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByTestId('org-select')).toBeNull();
    // No /api/orgs call when the flag is off.
    const orgCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/orgs'));
    expect(orgCalls).toHaveLength(0);
  });

  it('flag on: shows the coordinator org selector but never a tab switch', async () => {
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

    renderView({ orgHierarchyEnabled: true });

    // Owner registration is a deep link now — the public page has no tabs.
    expect(screen.queryByRole('tab')).toBeNull();
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

    renderView({ orgHierarchyEnabled: true });

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

    renderView({ orgHierarchyEnabled: true });

    // Wait until the org option is present (list loaded) before selecting, so
    // the native-select value actually resolves to 'o1'.
    await screen.findByRole('option', { name: 'Enable India' });
    const select = await screen.findByTestId('org-select');
    fireEvent.change(select, { target: { value: 'o1' } });
    fireEvent.submit(screen.getByTestId('rjsf-shim'));

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

    renderView({ orgHierarchyEnabled: true });

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
