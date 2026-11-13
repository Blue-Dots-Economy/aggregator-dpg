import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { ResendInviteButton } from '@/components/console/ResendInviteButton';

const ORG = '00000000-0000-4000-8000-0000000000a1';

function show(kind: 'user' | 'org') {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ResendInviteButton kind={kind} orgId={ORG} email="late@x.org" />
    </NextIntlClientProvider>,
  );
}

describe('ResendInviteButton', () => {
  beforeEach(() => {
    refresh.mockReset();
    vi.restoreAllMocks();
  });

  it('re-invites a user into the org and refreshes the list', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }));
    show('user');
    fireEvent.click(screen.getByRole('button', { name: 'Resend the invite to late@x.org' }));
    await waitFor(() => expect(screen.getByText('Sent')).toBeInTheDocument());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/console/user/invite');
    expect(JSON.parse(String(init?.body))).toEqual({
      org_id: ORG,
      recipients: [{ email: 'late@x.org' }],
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('re-invites an organisation under the parent', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }));
    show('org');
    fireEvent.click(screen.getByRole('button', { name: /Resend/ }));
    await waitFor(() => expect(screen.getByText('Sent')).toBeInTheDocument());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/console/org/invite');
    expect(JSON.parse(String(init?.body))).toEqual({
      parent_id: ORG,
      recipients: [{ email: 'late@x.org' }],
    });
  });

  it('says so when the resend fails, and keeps the button', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'SERVER' } }), { status: 500 }),
    );
    show('user');
    fireEvent.click(screen.getByRole('button', { name: /Resend/ }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't resend. Try again."),
    );
    expect(screen.getByRole('button', { name: /Resend/ })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
