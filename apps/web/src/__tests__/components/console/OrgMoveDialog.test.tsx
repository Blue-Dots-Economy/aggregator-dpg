/**
 * Unit tests for OrgMoveDialog: moving an organisation under a new parent.
 *
 * Covers: loading the candidate parents, a refused candidate shown disabled
 * with its reason, the number of organisations that move, a move that keeps
 * the "known as" value, a move that needs a new value, and an error.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { OrgMoveDialog } from '@/components/console/OrgMoveDialog';

const ORG = '00000000-0000-4000-8000-0000000000d1';

const VALUES = [
  { key: 'aggregator', name: 'Aggregator', depths: null, system: true, org_count: 2 },
  { key: 'state', name: 'State', depths: [1], system: false, org_count: 1 },
  { key: 'district', name: 'District', depths: [2], system: false, org_count: 1 },
];

const OPTIONS = {
  subtree_size: 3,
  options: [
    { id: 'root', name: 'The Network', depth: 0, known_as_name: null, ok: true, reason: null },
    { id: 's1', name: 'State One', depth: 1, known_as_name: 'State', ok: true, reason: null },
    {
      id: 'd2',
      name: 'District Two',
      depth: 2,
      known_as_name: 'District',
      ok: false,
      reason: 'DEPTH_LIMIT',
    },
    {
      id: 's3',
      name: 'State Three',
      depth: 1,
      known_as_name: 'State',
      ok: false,
      reason: 'KNOWN_AS_DEPTH',
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers the options read, then each PATCH with `patch`. */
function fetchWith(patch: Response) {
  return vi.fn(async (_url: unknown, init?: { method?: string }) =>
    init?.method === 'PATCH' ? patch : json(OPTIONS),
  );
}

function renderIt() {
  render(
    <StrictMode>
      <NextIntlClientProvider locale="en" messages={messages}>
        <OrgMoveDialog orgId={ORG} orgName="Mysuru" knownAs="district" knownAsValues={VALUES} />
      </NextIntlClientProvider>
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole('button', { name: messages.console.org.move }));
}

const parentSelect = () => screen.findByLabelText(messages.console.org.move_parent);
const submit = () => screen.getByRole('button', { name: messages.console.org.move_submit });

describe('<OrgMoveDialog />', () => {
  const original = global.fetch;
  beforeAll(() => {
    // jsdom has no <dialog> showModal/close.
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    // Like a browser, close() fires a "close" event when the dialog was open.
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

  it('stays open when React runs its effects twice', async () => {
    global.fetch = fetchWith(json({})) as never;
    renderIt();
    expect(await parentSelect()).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    global.fetch = fetchWith(json({})) as never;
    renderIt();
    await parentSelect();
    fireEvent(screen.getByRole('dialog'), new Event('cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes on Cancel and opens again on Move', async () => {
    global.fetch = fetchWith(json({})) as never;
    renderIt();
    await parentSelect();
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.move_cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.move }));
    expect(await parentSelect()).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('loads the candidates, disables a refused one with its reason, and shows the count', async () => {
    global.fetch = fetchWith(json({})) as never;
    renderIt();
    await parentSelect();
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/parent/options/${ORG}`,
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    const refused = screen.getByRole('option', {
      name: `District Two (District) — ${messages.console.org.move_reason_depth}`,
    });
    expect(refused).toBeDisabled();
    expect(
      screen.getByRole('option', {
        name: `State Three (State) — ${messages.console.org.move_reason_known_as_depth}`,
      }),
    ).toBeDisabled();
    expect(screen.getByRole('option', { name: 'State One (State)' })).not.toBeDisabled();
    expect(screen.getByText('3 organisations will move.')).toBeInTheDocument();
    expect(submit()).toBeDisabled();
  });

  it('moves under a parent where the value is allowed, sending only the parent', async () => {
    global.fetch = fetchWith(json({ id: ORG })) as never;
    renderIt();
    fireEvent.change(await parentSelect(), { target: { value: 's1' } });
    expect(screen.queryByLabelText(messages.console.org.move_known_as)).toBeNull();
    fireEvent.click(submit());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/parent/${ORG}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ parent_id: 's1' }) }),
    );
  });

  it('asks for a new value when the current one is not allowed at the new depth', async () => {
    global.fetch = fetchWith(json({ id: ORG })) as never;
    renderIt();
    fireEvent.change(await parentSelect(), { target: { value: 'root' } });
    const knownAs = screen.getByLabelText(messages.console.org.move_known_as);
    expect(screen.getByRole('option', { name: 'State' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'District' })).toBeNull();
    expect(submit()).toBeDisabled();
    fireEvent.change(knownAs, { target: { value: 'state' } });
    fireEvent.click(submit());
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/console/org/parent/${ORG}`,
        expect.objectContaining({
          body: JSON.stringify({ parent_id: 'root', known_as: 'state' }),
        }),
      ),
    );
  });

  it('shows the error message when the move is refused', async () => {
    global.fetch = fetchWith(json({ error: { code: 'ORG_CHILD_LIMIT' } }, 409)) as never;
    renderIt();
    fireEvent.change(await parentSelect(), { target: { value: 's1' } });
    fireEvent.click(submit());
    expect(await screen.findByText(messages.console.errors.child_limit)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows a plain message when the candidates cannot be read', async () => {
    global.fetch = vi.fn(async () => json({ error: { code: 'BOOM' } }, 500)) as never;
    renderIt();
    expect(await screen.findByText(messages.console.errors.server)).toBeInTheDocument();
  });
});
