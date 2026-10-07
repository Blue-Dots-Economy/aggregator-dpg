import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { User } from '@aggregator-dpg/shared-primitives/user-org';
import { CoordinatorActions } from '@/components/console/CoordinatorActions';

const user: User = {
  id: '00000000-0000-4000-8000-0000000000c1',
  user_type: 'coordinator',
  status: 'pending',
  name: 'Coordinator One',
  contact: { name: 'C1', email: 'c1@x.org', phone: null },
  serves: [],
  org_id: null,
  invited: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  rejected_at: null,
};

function renderIt() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CoordinatorActions user={user} domains={[{ id: 'seeker', label: 'Seekers' }]} />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('<CoordinatorActions />', () => {
  const original = global.fetch;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    global.fetch = original;
  });

  it('approves and shows the new status', async () => {
    global.fetch = respond({ id: user.id, status: 'active', notified: true }, 200) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    await waitFor(() =>
      expect(screen.getByTestId('coordinator-status')).toHaveTextContent(
        messages.console.status.active,
      ),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/decision/${user.id}`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ decision: 'approve' }) }),
    );
  });

  it('updates in place when the decision was already made elsewhere (C10)', async () => {
    global.fetch = respond(
      { error: { code: 'ALREADY_DECIDED', fields: { status: 'inactive', decided_by: 'link' } } },
      409,
    ) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    await waitFor(() =>
      expect(screen.getByTestId('coordinator-status')).toHaveTextContent(
        messages.console.status.inactive,
      ),
    );
    expect(screen.queryByRole('button', { name: messages.console.coordinator.approve })).toBeNull();
  });

  it('sends the optional reason with a reject', async () => {
    global.fetch = respond({ id: user.id, status: 'inactive', notified: true }, 200) as never;
    renderIt();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'incomplete' } });
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.reject }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ decision: 'reject', reason: 'incomplete' }),
        }),
      ),
    );
  });

  it('shows the rate-limit message on 429', async () => {
    global.fetch = respond({ error: { code: 'RATE_LIMITED' } }, 429) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    expect(await screen.findByText(messages.console.errors.rate_limited)).toBeInTheDocument();
  });
});
