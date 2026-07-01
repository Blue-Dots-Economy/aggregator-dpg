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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';

// Deterministic RJSF form: renders a submittable <form> plus children (the
// submit button). Fires onSubmit with an empty payload — RegisterView merges
// consent + org_id on top.
vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({
    onSubmit,
    children,
  }: {
    onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
    children?: ReactNode;
  }) => (
    <form
      data-testid="rjsf-shim"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSubmit({ formData: { name: 'Coord' } }, ev);
      }}
    >
      {children}
    </form>
  ),
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

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const submitCall = calls.find((c) => c.url.includes('/api/aggregator/register'));
    expect(submitCall).toBeDefined();
    expect(JSON.parse(submitCall!.body)).toMatchObject({ org_id: 'o1' });
  });
});
