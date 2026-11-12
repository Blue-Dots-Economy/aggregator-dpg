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

function renderIt(
  u: User = user,
  domains: Array<{ id: string; label: string }> = [{ id: 'seeker', label: 'Seekers' }],
  readOnly = false,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CoordinatorActions user={u} domains={domains} readOnly={readOnly} />
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

  const saveButton = () =>
    screen.getByRole('button', { name: messages.console.coordinator.save_domains });

  it('shows a coordinator with no saved domains as serving every configured domain', () => {
    renderIt(user, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    expect(screen.getByRole('checkbox', { name: /Seekers/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Providers/ })).toBeChecked();
    expect(
      screen.queryByRole('button', { name: messages.console.coordinator.save_domains }),
    ).toBeNull();
  });

  it('narrows the domains and saves the chosen ones', async () => {
    global.fetch = respond({ ...user, serves: ['seeker'] }, 200) as never;
    renderIt(user, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Providers/ }));
    expect(screen.getByText(messages.console.coordinator.unsaved)).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByText(messages.console.coordinator.domains_saved)).toBeInTheDocument(),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/metadata/${user.id}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ serves: ['seeker'] }) }),
    );
    expect(screen.getByRole('checkbox', { name: /Providers/ })).not.toBeChecked();
  });

  it('blocks saving an empty set and discards back to what was saved', () => {
    renderIt({ ...user, serves: ['seeker'] }, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Seekers/ }));
    expect(screen.getByText(messages.console.coordinator.domains_empty)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.discard }));
    expect(screen.getByRole('checkbox', { name: /Seekers/ })).toBeChecked();
    expect(
      screen.queryByRole('button', { name: messages.console.coordinator.save_domains }),
    ).toBeNull();
  });

  it('shows a generic error when saving domains fails', async () => {
    global.fetch = respond({ error: { code: 'BOOM' } }, 500) as never;
    renderIt(user, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Providers/ }));
    fireEvent.click(saveButton());
    expect(await screen.findByText(messages.console.coordinator.error.server)).toBeInTheDocument();
  });

  it('does not render the domains card when no domains are offered', () => {
    renderIt(user, []);
    expect(
      screen.queryByRole('button', { name: messages.console.coordinator.save_domains }),
    ).toBeNull();
  });

  it('shows status and served domains without any action when read-only (#873)', () => {
    renderIt(
      { ...user, serves: ['seeker'] },
      [
        { id: 'seeker', label: 'Seekers' },
        { id: 'provider', label: 'Providers' },
      ],
      true,
    );
    expect(screen.queryByTestId('coordinator-status')).toBeNull();
    expect(screen.getByText('Seekers')).toBeInTheDocument();
    expect(screen.queryByText('Providers')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows the domains read-only once the coordinator is decided', () => {
    renderIt({ ...user, status: 'active', serves: ['seeker'] }, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    expect(screen.getByText('Seekers')).toBeInTheDocument();
    expect(screen.queryByText('Providers')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('lists every configured domain when a read-only coordinator has none saved', () => {
    renderIt(
      user,
      [
        { id: 'seeker', label: 'Seekers' },
        { id: 'provider', label: 'Providers' },
      ],
      true,
    );
    expect(screen.getByText('Seekers')).toBeInTheDocument();
    expect(screen.getByText('Providers')).toBeInTheDocument();
  });
});
