/**
 * View test: <PublicRegistrationView /> sends the coordinates the registrant
 * picked in an address widget as `item_locations`.
 *
 * RJSF is replaced by a shim whose buttons call the `formContext` callbacks
 * the location widgets use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';

interface ShimFormContext {
  onLocationResolved: (place: { lat: number; lng: number; label: string } | null) => void;
  onLocationsResolved: (coords: Array<{ lat: number; lng: number }>) => void;
}

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({
    onSubmit,
    formContext,
    children,
  }: {
    onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
    formContext: ShimFormContext;
    children?: React.ReactNode;
  }) => (
    <form
      data-testid="rjsf-shim"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSubmit({ formData: { name: 'A' } }, ev);
      }}
    >
      <button
        type="button"
        onClick={() => formContext.onLocationResolved({ lat: 12.9, lng: 77.6, label: 'Bengaluru' })}
      >
        pick-one
      </button>
      <button type="button" onClick={() => formContext.onLocationResolved(null)}>
        clear-one
      </button>
      <button
        type="button"
        onClick={() =>
          formContext.onLocationsResolved([
            { lat: 1, lng: 2 },
            { lat: 3, lng: 4 },
          ])
        }
      >
        pick-many
      </button>
      {children}
    </form>
  ),
}));

vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({
    data: {
      brand: { short_name: 'Test', primary_color: '#4338ca' },
      domains: [{ id: 'seeker', label: 'Seeker' }],
    },
    isError: false,
  }),
  DEFAULT_AGGREGATOR_CONFIG: { brand: { short_name: 'Test' }, domains: [] },
}));

import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ outcome: 'passed', submission_id: 's' }), { status: 201 }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <PublicRegistrationView
          org="acme"
          slug="winter25"
          domain="seeker"
          context={{}}
          schema={{ type: 'object', properties: { name: { type: 'string' } } }}
          uiSchema={{}}
          identity={{ name: 'name' }}
          submissionShape="account_and_profile"
          publicHintI18nKey={null}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** Submits and returns the parsed `/submit` body. */
async function submittedBody(): Promise<Record<string, unknown>> {
  fireEvent.submit(screen.getByTestId('rjsf-shim'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const init: unknown = fetchMock.mock.calls[0]?.[1];
  const body =
    typeof init === 'object' && init !== null && 'body' in init ? String(init.body) : '{}';
  return JSON.parse(body);
}

describe('<PublicRegistrationView /> — picked coordinates', () => {
  it('sends only lat/lng of a single picked place', async () => {
    renderView();
    fireEvent.click(screen.getByText('pick-one'));
    expect((await submittedBody())['item_locations']).toEqual([{ lat: 12.9, lng: 77.6 }]);
  });

  it('sends every coordinate from the multi-value widget', async () => {
    renderView();
    fireEvent.click(screen.getByText('pick-many'));
    expect((await submittedBody())['item_locations']).toEqual([
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
    ]);
  });

  it('omits item_locations when nothing is picked or the pick is cleared', async () => {
    renderView();
    fireEvent.click(screen.getByText('pick-one'));
    fireEvent.click(screen.getByText('clear-one'));
    expect(await submittedBody()).not.toHaveProperty('item_locations');
  });
});
