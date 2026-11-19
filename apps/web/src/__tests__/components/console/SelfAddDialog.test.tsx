/**
 * `AddMyselfButton`: an org owner adds their own coordinator account to My Team.
 *
 * Covers: the profile-type choice is required, the organisation picker shows
 * only for an owner of several organisations, the consent gate runs before the
 * request, the request body, a refresh on success, and the API's refusals
 * shown inline.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { ConsentDocContent } from '@/components/consent/consent-types';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
// The gate's own reading rules are tested in ConsentGate.test.tsx; here it accepts on a click.
vi.mock('@/components/consent/ConsentGate', () => ({
  ConsentGate: (props: { open: boolean; agreeLabel: string; onAccept: () => void }) =>
    props.open ? (
      <button type="button" onClick={props.onAccept}>
        {`gate: ${props.agreeLabel}`}
      </button>
    ) : null,
}));

import { AddMyselfButton } from '@/components/console/SelfAddDialog';

const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b2';
const DOMAINS = [
  { id: 'seeker', label: 'Seekers' },
  { id: 'provider', label: 'Providers' },
];
const CONSENT: ConsentDocContent = {
  terms: { version: 1, title: 'Terms', content: 'Terms text' },
  privacy: { version: 1, title: 'Privacy', content: 'Privacy text' },
};

const t = messages.console.self_add;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const created = {
  id: '00000000-0000-4000-8000-0000000000c3',
  org_id: ORG_A,
  name: 'Org A',
  status: 'active',
  serves: ['seeker'],
  contact: { name: 'Owner', email: 'o@a.org', phone: '+919999999999' },
  created_at: '2026-11-19T00:00:00Z',
  updated_at: '2026-11-19T00:00:00Z',
  approved_at: '2026-11-19T00:00:00Z',
  rejected_at: null,
};

function renderIt(
  orgs = [{ id: ORG_A, name: 'Org A' }],
  consent: ConsentDocContent | null = CONSENT,
) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AddMyselfButton orgs={orgs} domains={DOMAINS} consent={consent} />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: t.button }));
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: t.submit }));

/** Accepts the consent gate, which uses the coordinator registration's agreement copy. */
async function acceptConsent() {
  fireEvent.click(await screen.findByRole('button', { name: /^gate: .*Terms of Service/ }));
}

const gateButton = () => screen.queryByRole('button', { name: /^gate:/ });

describe('<AddMyselfButton />', () => {
  const original = global.fetch;
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    });
  });
  afterEach(() => {
    global.fetch = original;
    vi.clearAllMocks();
  });

  it('refuses an empty profile-type selection without calling the API', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    renderIt();
    submit();
    expect(
      await screen.findByText(messages.form.error_required.replace('{label}', t.serves)),
    ).toBeInTheDocument();
    expect(gateButton()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('asks for the organisation only when the owner owns more than one', () => {
    renderIt();
    expect(screen.queryByLabelText(t.org)).toBeNull();
  });

  it('shows the organisation picker for an owner of several organisations', () => {
    renderIt([
      { id: ORG_A, name: 'Org A' },
      { id: ORG_B, name: 'Org B' },
    ]);
    expect(screen.getByLabelText(t.org)).toBeInTheDocument();
  });

  it('posts the organisation, the profile types and the consent, then refreshes', async () => {
    const fetchSpy = vi.fn(async () => json(created, 201));
    global.fetch = fetchSpy;
    renderIt();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seekers' }));
    submit();
    await acceptConsent();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/console/user/self-add');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ org_id: ORG_A, serves: ['seeker'], consent: { value: true } });
    expect(body['consent']).toHaveProperty('given_at');
    expect(body['consent']).toHaveProperty('valid_till');
  });

  it('shows ALREADY_COORDINATOR inline and does not refresh', async () => {
    global.fetch = vi.fn(async () =>
      json({ error: { code: 'ALREADY_COORDINATOR', title: 'Conflict' } }, 409),
    );
    renderIt();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Providers' }));
    submit();
    await acceptConsent();
    expect(
      await screen.findByText(messages.console.errors.already_coordinator),
    ).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('asks for a phone number on OWNER_PHONE_REQUIRED', async () => {
    global.fetch = vi.fn(async () =>
      json({ error: { code: 'OWNER_PHONE_REQUIRED', title: 'Bad request' } }, 400),
    );
    renderIt();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seekers' }));
    submit();
    await acceptConsent();
    expect(
      await screen.findByText(messages.console.errors.owner_phone_required),
    ).toBeInTheDocument();
  });

  it('shows ORG_NOT_ELIGIBLE inline', async () => {
    global.fetch = vi.fn(async () =>
      json({ error: { code: 'ORG_NOT_ELIGIBLE', title: 'Forbidden' } }, 403),
    );
    renderIt();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seekers' }));
    submit();
    await acceptConsent();
    expect(await screen.findByText(messages.console.errors.org_not_eligible)).toBeInTheDocument();
  });

  it('says the terms could not be loaded instead of opening the consent gate', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    renderIt([{ id: ORG_A, name: 'Org A' }], null);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seekers' }));
    submit();
    expect(
      await screen.findByText(messages.register.consent.load_failed_detail),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
