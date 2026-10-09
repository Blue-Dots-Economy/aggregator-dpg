import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type {
  PermissionGrant,
  UserGrantsResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { GrantsPanel } from '@/components/console/GrantsPanel';

const userId = '00000000-0000-4000-8000-0000000000c1';
const grantable = [{ grant_key: 'pii_access', capability: 'profiles.view_pii', max_days: 90 }];

const live: PermissionGrant = {
  grant_key: 'pii_access',
  capability: 'profiles.view_pii',
  granted_at: '2026-10-01T00:00:00Z',
  expires_at: '2026-12-30T00:00:00Z',
  granted_by: '00000000-0000-4000-8000-0000000000a1',
  revoked_at: null,
  live: true,
};

function renderIt(initial: UserGrantsResponse) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <GrantsPanel userId={userId} initial={initial} />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('<GrantsPanel />', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });

  it('renders nothing when no grant is available', () => {
    const { container } = renderIt({ grants: [], grantable: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('grants PII Access and shows its expiry', async () => {
    global.fetch = respond(live, 201) as never;
    renderIt({ grants: [], grantable });
    expect(screen.getByTestId('grant-pii_access')).toHaveTextContent(messages.console.grants.none);
    fireEvent.click(screen.getByRole('button', { name: 'Grant for 90 days' }));
    await waitFor(() =>
      expect(screen.getByTestId('grant-pii_access')).toHaveTextContent('Active until 2026-12-30'),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/grant/${userId}`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ grant_key: 'pii_access' }),
      }),
    );
    expect(
      screen.getByRole('button', { name: messages.console.grants.revoke }),
    ).toBeInTheDocument();
  });

  it('revokes a live grant', async () => {
    global.fetch = respond({ revoked: true }, 200) as never;
    renderIt({ grants: [live], grantable });
    fireEvent.click(screen.getByRole('button', { name: messages.console.grants.revoke }));
    await waitFor(() =>
      expect(screen.getByTestId('grant-pii_access')).toHaveTextContent(
        messages.console.grants.none,
      ),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/grant/revoke/${userId}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('explains a grant the organisation cannot give', async () => {
    global.fetch = respond({ error: { code: 'PERMISSION_GRANT_EXCEEDS_ORG_SET' } }, 409) as never;
    renderIt({ grants: [], grantable });
    fireEvent.click(screen.getByRole('button', { name: 'Grant for 90 days' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        messages.console.errors.grant_not_allowed,
      ),
    );
    expect(screen.getByTestId('grant-pii_access')).toHaveTextContent(messages.console.grants.none);
  });
});
