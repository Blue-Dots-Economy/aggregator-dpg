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
  serves: ['seeker', 'provider'],
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

/** The removal note as the test renders it, with the raw `[[user]]` placeholder. */
const removalNote = (domains: string) =>
  messages.console.coordinator.remove_domains_note.replace('{domains}', domains);

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

  it('shows a coordinator with no saved domains with none ticked', () => {
    renderIt({ ...user, serves: [] }, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    expect(screen.getByRole('checkbox', { name: /Seekers/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Providers/ })).not.toBeChecked();
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
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByText(removalNote('Providers'))).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: messages.console.coordinator.remove_domains_confirm }),
    );
    await waitFor(() =>
      expect(screen.getByText(messages.console.coordinator.domains_saved)).toBeInTheDocument(),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/metadata/${user.id}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ serves: ['seeker'] }) }),
    );
    expect(screen.getByRole('checkbox', { name: /Providers/ })).not.toBeChecked();
  });

  it('saves an added domain without asking for confirmation', async () => {
    global.fetch = respond({ ...user, serves: ['seeker', 'provider'] }, 200) as never;
    renderIt({ ...user, serves: ['seeker'] }, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Providers/ }));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByText(messages.console.coordinator.domains_saved)).toBeInTheDocument(),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/metadata/${user.id}`,
      expect.objectContaining({ body: JSON.stringify({ serves: ['seeker', 'provider'] }) }),
    );
  });

  it('cancels a domain removal without saving and keeps the change unsaved', () => {
    global.fetch = respond({}, 200) as never;
    renderIt(user, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Providers/ }));
    fireEvent.click(saveButton());
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.cancel }));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByText(messages.console.coordinator.unsaved)).toBeInTheDocument();
    expect(saveButton()).toBeInTheDocument();
  });

  it('refuses to save an empty set with the message under it, and discards back to what was saved', () => {
    renderIt({ ...user, serves: ['seeker'] }, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Seekers/ }));
    expect(screen.getByText(messages.console.coordinator.domains_empty)).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: messages.console.coordinator.domains }),
    ).toHaveAttribute('aria-invalid', 'true');
    global.fetch = vi.fn() as never;
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    expect(global.fetch).not.toHaveBeenCalled();
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
    fireEvent.click(
      screen.getByRole('button', { name: messages.console.coordinator.remove_domains_confirm }),
    );
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

  it.each(['inactive', 'retired'] as const)(
    'shows the domains read-only for a %s coordinator',
    (status) => {
      renderIt({ ...user, status, serves: ['seeker'] }, [
        { id: 'seeker', label: 'Seekers' },
        { id: 'provider', label: 'Providers' },
      ]);
      expect(screen.getByText('Seekers')).toBeInTheDocument();
      expect(screen.queryByText('Providers')).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
    },
  );

  it('lets an approved coordinator have its domains changed, confirming a removal', async () => {
    global.fetch = respond({ ...user, status: 'active', serves: ['provider'] }, 200) as never;
    renderIt({ ...user, status: 'active', serves: ['seeker', 'provider'] }, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Seekers/ }));
    fireEvent.click(saveButton());
    expect(screen.getByText(removalNote('Seekers'))).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: messages.console.coordinator.remove_domains_confirm }),
    );
    await waitFor(() =>
      expect(screen.getByText(messages.console.coordinator.domains_saved)).toBeInTheDocument(),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/metadata/${user.id}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ serves: ['provider'] }) }),
    );
  });

  it('lists no domain when a read-only coordinator has none saved', () => {
    renderIt(
      { ...user, serves: [] },
      [
        { id: 'seeker', label: 'Seekers' },
        { id: 'provider', label: 'Providers' },
      ],
      true,
    );
    expect(screen.queryByText('Seekers')).toBeNull();
    expect(screen.queryByText('Providers')).toBeNull();
  });

  it('drops a saved id the network no longer has and saves in network order', async () => {
    global.fetch = respond({ ...user, serves: ['seeker', 'provider'] }, 200) as never;
    renderIt({ ...user, serves: ['gone', 'provider'] }, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    expect(screen.getByRole('checkbox', { name: /Providers/ })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /Seekers/ }));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/console/user/metadata/${user.id}`,
        expect.objectContaining({ body: JSON.stringify({ serves: ['seeker', 'provider'] }) }),
      ),
    );
  });
});
