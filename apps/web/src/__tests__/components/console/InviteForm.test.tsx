/**
 * Unit tests for InviteForm.
 *
 * Covers: rendering the org select, the no-recipients short-circuit, a
 * successful invite (with invalid + existing breakdown), an error response,
 * and switching the chosen organisation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { InviteForm } from '@/components/console/InviteForm';

const orgs = [
  { id: 'org-1', name: 'First Org' },
  { id: 'org-2', name: 'Second Org' },
];

function renderForm(list = orgs) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InviteForm orgs={list} />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('<InviteForm />', () => {
  const original = global.fetch;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    global.fetch = original;
  });

  it('renders the org options and defaults to the first', () => {
    renderForm();
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select).toHaveValue('org-1');
    expect(screen.getByRole('option', { name: 'Second Org' })).toBeInTheDocument();
  });

  it('does not call the API when the textarea has no addresses', () => {
    global.fetch = respond({}, 200) as never;
    renderForm();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   \n ; ,' } });
    fireEvent.click(screen.getByRole('button', { name: messages.console.invite.send }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('splits recipients, posts them and shows the result breakdown', async () => {
    global.fetch = respond(
      {
        sent: 2,
        resent: 1,
        invalid: [{ email: 'bad@', reason: 'invalid' }],
        existing: [{ email: 'known@x.org', status: 'active' }],
      },
      200,
    ) as never;
    renderForm();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'a@x.org\nb@x.org, c@x.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: messages.console.invite.send }));
    await waitFor(() =>
      expect(screen.getByText(/Sent 2, resent 1/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/bad@/)).toBeInTheDocument();
    expect(screen.getByText(/known@x.org/)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/console/user/invite',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          org_id: 'org-1',
          recipients: [{ email: 'a@x.org' }, { email: 'b@x.org' }, { email: 'c@x.org' }],
        }),
      }),
    );
  });

  it('shows an error alert when the invite fails', async () => {
    global.fetch = respond({ error: { code: 'BOOM' } }, 500) as never;
    renderForm();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a@x.org' } });
    fireEvent.click(screen.getByRole('button', { name: messages.console.invite.send }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(messages.console.errors.generic);
  });

  it('posts to the chosen organisation after switching the select', async () => {
    global.fetch = respond({ sent: 1, resent: 0, invalid: [], existing: [] }, 200) as never;
    renderForm();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'org-2' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a@x.org' } });
    fireEvent.click(screen.getByRole('button', { name: messages.console.invite.send }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ org_id: 'org-2', recipients: [{ email: 'a@x.org' }] }),
        }),
      ),
    );
  });

  it('disables the send button when there are no organisations', () => {
    renderForm([]);
    expect(screen.getByRole('button', { name: messages.console.invite.send })).toBeDisabled();
  });
});
