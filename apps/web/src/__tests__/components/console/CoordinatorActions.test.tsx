import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { User } from '@aggregator-dpg/shared-primitives/user-org';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

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

  it('shows the review prompt with the name and registration date', () => {
    renderIt();
    expect(screen.getByText(messages.console.coordinator.decision_title)).toBeInTheDocument();
    expect(
      screen.getByText(
        'C1 registered on Jan 1, 2026. Approve to let them sign in, or reject the registration.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('asks for the optional reason only after Reject, and cancels back', () => {
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.reject }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: messages.console.coordinator.approve })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.cancel }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(
      screen.getByRole('button', { name: messages.console.coordinator.approve }),
    ).toBeInTheDocument();
  });

  it('sends the optional reason with a reject', async () => {
    global.fetch = respond({ id: user.id, status: 'inactive', notified: true }, 200) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.reject }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'incomplete' } });
    fireEvent.click(
      screen.getByRole('button', { name: messages.console.coordinator.reject_confirm }),
    );
    expect(await screen.findByText(messages.console.coordinator.rejected_note)).toBeInTheDocument();
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
    expect(
      await screen.findByText(messages.console.coordinator.error.rate_limited),
    ).toBeInTheDocument();
  });

  it('explains a missing account in plain words', async () => {
    global.fetch = respond({ error: { code: 'NOT_FOUND' } }, 404) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    expect(
      await screen.findByText(messages.console.coordinator.error.not_found),
    ).toBeInTheDocument();
  });

  it('says when the organisation is not active', async () => {
    global.fetch = respond({ error: { code: 'TARGET_ORG_INACTIVE' } }, 409) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    expect(
      await screen.findByText(messages.console.coordinator.error.org_inactive),
    ).toBeInTheDocument();
  });

  it('asks for profile types when the approval is refused for having none', async () => {
    global.fetch = respond({ error: { code: 'NO_PROFILE_TYPES' } }, 409) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    expect(
      await screen.findByText(messages.console.coordinator.error.no_profile_types),
    ).toBeInTheDocument();
  });

  it('confirms the approval on success', async () => {
    global.fetch = respond({ id: user.id, status: 'active', notified: true }, 200) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    expect(await screen.findByText(messages.console.coordinator.approved_note)).toBeInTheDocument();
  });

  it('shows no decision card for a coordinator who is not pending', () => {
    renderIt({ ...user, status: 'active' });
    expect(screen.queryByRole('button', { name: messages.console.coordinator.approve })).toBeNull();
    expect(screen.queryByText(messages.console.coordinator.decision_title)).toBeNull();
    expect(screen.queryByTestId('coordinator-status')).toBeNull();
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

  it('keeps the shown status when an already-decided reply names an unknown status', async () => {
    global.fetch = respond(
      { error: { code: 'ALREADY_DECIDED', fields: { status: 'archived' } } },
      409,
    ) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    await waitFor(() =>
      expect(
        screen.getByText(messages.console.coordinator.already.replace('{status}', '').trim()),
      ).toBeInTheDocument(),
    );
    // The coordinator is still shown as pending, so no decided-status pill renders.
    expect(screen.queryByTestId('coordinator-status')).toBeNull();
  });

  it('says the reply could not be read when a decision reply has the wrong shape', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    global.fetch = respond({ id: user.id, status: 'approved' }, 200) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    expect(await screen.findByText(messages.console.errors.response_shape)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
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

  it('holds the decision until unsaved domain changes are saved or discarded', () => {
    renderIt(user, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Providers/ }));
    expect(screen.getByText(messages.console.coordinator.save_domains_first)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: messages.console.coordinator.approve }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: messages.console.coordinator.reject }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.discard }));
    expect(
      screen.getByRole('button', { name: messages.console.coordinator.approve }),
    ).toBeEnabled();
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

  it('keeps the domains editable right after an approval', async () => {
    global.fetch = respond({ id: user.id, status: 'active', notified: true }, 200) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    expect(await screen.findByText(messages.console.coordinator.approved_note)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Seekers/ })).toBeInTheDocument();
  });

  it('stops editing domains right after a rejection', async () => {
    global.fetch = respond({ id: user.id, status: 'inactive', notified: true }, 200) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.reject }));
    fireEvent.click(
      screen.getByRole('button', { name: messages.console.coordinator.reject_confirm }),
    );
    await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull());
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
