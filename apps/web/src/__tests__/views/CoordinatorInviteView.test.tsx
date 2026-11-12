/**
 * View test: <CoordinatorInviteView /> — the coordinator invite landing.
 *
 * The invite is read on the server; the view either wires the form with the
 * org and the locked email, or explains why the link cannot be used. The RJSF
 * form is stubbed.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { InviteReadResult } from '@/lib/invite-read.server';

vi.mock('@/hooks/useAggregatorConfig', () => {
  const cfg = { brand: { short_name: 'Test Aggregator' } };
  return {
    useAggregatorConfig: () => ({ data: cfg, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: cfg,
  };
});

vi.mock('@/app/(public)/register/CoordinatorRegisterForm', () => ({
  CoordinatorRegisterForm: (props: {
    inviteToken?: string;
    lockedOrgName?: string;
    lockedEmail?: string;
  }) => (
    <div data-testid="coordinator-form">
      <span data-testid="org">{props.lockedOrgName}</span>
      <span data-testid="email">{props.lockedEmail}</span>
      <span data-testid="token">{props.inviteToken}</span>
    </div>
  ),
}));

import { CoordinatorInviteView } from '@/app/(public)/register/coordinator/CoordinatorInviteView';

const SCHEMA = { title: 'Aggregator Registration', type: 'object' as const };

function renderView(invite: InviteReadResult) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CoordinatorInviteView schema={SCHEMA} uiSchema={{}} inviteToken="tok" invite={invite} />
    </NextIntlClientProvider>,
  );
}

describe('<CoordinatorInviteView />', () => {
  it('wires the form with the inviting org, the invited email and the token', () => {
    renderView({
      ok: true,
      invite: {
        email: 'asha@trrain.org',
        expires_at: '2099-01-01T00:00:00.000Z',
        org: { id: 'o1', name: 'TRRAIN' },
      },
    });
    expect(screen.getByTestId('org')).toHaveTextContent('TRRAIN');
    expect(screen.getByTestId('email')).toHaveTextContent('asha@trrain.org');
    expect(screen.getByTestId('token')).toHaveTextContent('tok');
  });

  it.each([
    ['invalid', 'This invitation link is not valid.'],
    ['expired', 'This invitation has expired.'],
    ['used', 'This invitation has already been used.'],
    ['org_inactive', "This invitation can't be used right now."],
    ['unavailable', "We couldn't load your invitation."],
  ] as const)('explains a %s invite and offers sign-in, without the form', (reason, text) => {
    renderView({ ok: false, reason });
    expect(screen.getByText(new RegExp(text.replace(/[.()]/g, '\\$&')))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.queryByTestId('coordinator-form')).not.toBeInTheDocument();
  });
});
