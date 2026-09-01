/**
 * View test: <OwnerInviteView /> — the org-owner bulk invite surface (#701).
 *
 * Covers the bulk-mint happy path (summary render), the expired-grant recovery
 * action, and the invalid-grant banner. `fetch` is stubbed per case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';

vi.mock('@/hooks/useAggregatorConfig', () => {
  const cfg = { brand: { short_name: 'Test Aggregator' } };
  return {
    useAggregatorConfig: () => ({ data: cfg, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: cfg,
  };
});

import { OwnerInviteView } from '@/app/(public)/register/invite/OwnerInviteView';

function renderView() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OwnerInviteView grant="grant-jwt" />
    </NextIntlClientProvider>,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('<OwnerInviteView />', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mints invites and renders the summary', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { recovered: false, sent: 2, resent: 1, invalid: [] }));
    vi.stubGlobal('fetch', fetchMock);

    renderView();
    fireEvent.change(screen.getByPlaceholderText(/asha@org\.in/i), {
      target: { value: 'a@x.org\nb@x.org, Bee' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText(/2 sent/)).toBeInTheDocument());
    // Body carried the grant + parsed recipients.
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(opts.body)) as { grant: string; recipients: unknown[] };
    expect(body.grant).toBe('grant-jwt');
    expect(body.recipients).toEqual([{ email: 'a@x.org' }, { email: 'b@x.org', name: 'Bee' }]);
  });

  it('shows the recovery banner when an expired grant re-mails a fresh link (recovered:true)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { recovered: true, sent: 0, resent: 0, invalid: [] })),
    );
    renderView();
    fireEvent.change(screen.getByPlaceholderText(/asha@org\.in/i), {
      target: { value: 'a@x.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/had expired/i)).toBeInTheDocument());
  });

  it('shows an invalid-grant banner on GRANT_INVALID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(400, { error: { code: 'GRANT_INVALID' } })),
    );
    renderView();
    fireEvent.change(screen.getByPlaceholderText(/asha@org\.in/i), {
      target: { value: 'a@x.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/not valid/i)).toBeInTheDocument());
  });

  it('shows a rate-limit message on 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, {})));
    renderView();
    fireEvent.change(screen.getByPlaceholderText(/asha@org\.in/i), {
      target: { value: 'a@x.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/too many invites/i)).toBeInTheDocument());
  });

  it('shows a network-error message when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    renderView();
    fireEvent.change(screen.getByPlaceholderText(/asha@org\.in/i), {
      target: { value: 'a@x.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/network error/i)).toBeInTheDocument());
  });

  it('lists invalid rows in the result summary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          recovered: false,
          sent: 1,
          resent: 0,
          invalid: [{ email: 'bad', reason: 'invalid_email' }],
        }),
      ),
    );
    renderView();
    fireEvent.change(screen.getByPlaceholderText(/asha@org\.in/i), {
      target: { value: 'a@x.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/1 invalid/)).toBeInTheDocument());
    expect(screen.getByText(/bad — invalid email/i)).toBeInTheDocument();
  });
});
