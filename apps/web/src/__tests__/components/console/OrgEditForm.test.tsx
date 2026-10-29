/**
 * Unit tests for OrgEditForm.
 *
 * Covers: editable vs read-only rendering, the admin-only rename gate, the
 * locations list (populated + empty), a no-change submit (no network call),
 * a successful patch, a field-clearing patch, and an error response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { Org } from '@aggregator-dpg/shared-primitives/user-org';
import { OrgEditForm } from '@/components/console/OrgEditForm';

const baseOrg: Org = {
  id: '00000000-0000-4000-8000-0000000000a1',
  slug: 'acme',
  name: 'Acme Org',
  org_type: 'aggregator',
  status: 'active',
  is_default: false,
  url: 'https://acme.example',
  locations: [
    {
      geo: { type: 'Point', coordinates: [77, 12] },
      address: { streetAddress: '1 Main St', addressLocality: 'Bengaluru', addressRegion: 'KA' },
    },
  ],
  legal_name: 'Acme Private Ltd',
  gst_number: 'GST123',
  known_as: 'aggregator',
  known_as_label: 'Aggregator',
  level: 3,
  parent_id: 'd1',
  parent_name: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const KNOWN_AS = [
  { key: 'state', label: 'State', level: 1 },
  { key: 'district', label: 'District', level: 2 },
  { key: 'aggregator', label: 'Aggregator', level: 3 },
];
const PARENTS = [
  { id: 'root', name: 'The Network', level: 0 },
  { id: 's1', name: 'State One', level: 1 },
  { id: 'd1', name: 'District One', level: 2 },
];

function renderForm(
  org: Org,
  editable: boolean,
  canRename: boolean,
  placement: { knownAs?: typeof KNOWN_AS; parents?: typeof PARENTS; hasChildren?: boolean } = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgEditForm
        org={org}
        editable={editable}
        canRename={canRename}
        knownAsOptions={placement.knownAs ?? []}
        parentOptions={placement.parents ?? []}
        hasChildren={placement.hasChildren ?? false}
      />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('<OrgEditForm />', () => {
  const original = global.fetch;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    global.fetch = original;
  });

  it('renders editable fields and the address list when editable', () => {
    renderForm(baseOrg, true, true);
    expect(screen.getByLabelText(messages.console.org.name)).not.toBeDisabled();
    expect(screen.getByLabelText(messages.console.org.url)).toHaveValue('https://acme.example');
    expect(screen.getByText('1 Main St, Bengaluru, KA')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: messages.console.org.save })).toBeInTheDocument();
    expect(screen.queryByText(messages.console.org.read_only)).toBeNull();
  });

  it('shows read-only details as text, with no inputs or save button', () => {
    renderForm({ ...baseOrg, gst_number: null }, false, false);
    expect(screen.getByText(messages.console.org.read_only)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: messages.console.org.save })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Acme Org')).toBeInTheDocument();
    expect(screen.getByText('1 Main St, Bengaluru, KA')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows "no locations" when a read-only org has none', () => {
    renderForm({ ...baseOrg, locations: [] }, false, false);
    expect(screen.getByText(messages.console.org.no_locations)).toBeInTheDocument();
  });

  it('disables the name and shows the admin-only hint when the owner cannot rename', () => {
    renderForm(baseOrg, true, false);
    expect(screen.getByLabelText(messages.console.org.name)).toBeDisabled();
    expect(screen.getByText(messages.console.org.name_admin_only)).toBeInTheDocument();
  });

  it('shows "no locations" when the org has none', () => {
    renderForm({ ...baseOrg, locations: [] }, true, true);
    expect(screen.getByText(messages.console.org.no_locations)).toBeInTheDocument();
  });

  it('skips the network call and reports saved when nothing changed', async () => {
    global.fetch = respond({}, 200) as never;
    renderForm(baseOrg, true, true);
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.save }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(messages.console.org.saved),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('patches only the changed fields and reports saved on success', async () => {
    const updated = { ...baseOrg, legal_name: 'New Legal Ltd' };
    global.fetch = respond(updated, 200) as never;
    renderForm(baseOrg, true, true);
    fireEvent.change(screen.getByLabelText(messages.console.org.legal_name), {
      target: { value: 'New Legal Ltd' },
    });
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.save }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(messages.console.org.saved),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/metadata/${baseOrg.id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ legal_name: 'New Legal Ltd' }),
      }),
    );
  });

  it('sends null to clear a field that was emptied', async () => {
    global.fetch = respond({ ...baseOrg, gst_number: null }, 200) as never;
    renderForm(baseOrg, true, true);
    fireEvent.change(screen.getByLabelText(messages.console.org.gst_number), {
      target: { value: '  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.save }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: JSON.stringify({ gst_number: null }) }),
      ),
    );
  });

  it('patches an edited website url', async () => {
    global.fetch = respond({ ...baseOrg, url: 'https://new.example' }, 200) as never;
    renderForm(baseOrg, true, true);
    fireEvent.change(screen.getByLabelText(messages.console.org.url), {
      target: { value: 'https://new.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.save }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: JSON.stringify({ url: 'https://new.example' }) }),
      ),
    );
  });

  it('includes a renamed name in the patch when the admin can rename', async () => {
    global.fetch = respond({ ...baseOrg, name: 'Acme Renamed' }, 200) as never;
    renderForm(baseOrg, true, true);
    fireEvent.change(screen.getByLabelText(messages.console.org.name), {
      target: { value: 'Acme Renamed' },
    });
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.save }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: JSON.stringify({ name: 'Acme Renamed' }) }),
      ),
    );
  });

  describe('known_as and parent (network admin)', () => {
    const full = { knownAs: KNOWN_AS, parents: PARENTS };

    it('offers each value with its level, and no parent picker until it changes', () => {
      renderForm(baseOrg, true, true, full);
      const select = screen.getByLabelText(messages.console.org.known_as);
      expect(select).toHaveValue('aggregator');
      expect(screen.getByRole('option', { name: 'District (Level 2)' })).toBeInTheDocument();
      expect(screen.queryByLabelText(messages.console.org.parent)).toBeNull();
    });

    it('asks for a parent one level up when the value changes, and sends both', async () => {
      global.fetch = respond(
        { ...baseOrg, known_as: 'district', known_as_label: 'District', level: 2, parent_id: 's1' },
        200,
      ) as never;
      renderForm(baseOrg, true, true, full);
      fireEvent.change(screen.getByLabelText(messages.console.org.known_as), {
        target: { value: 'district' },
      });
      const parent = screen.getByLabelText(messages.console.org.parent);
      // Only level-1 orgs can hold a level-2 value.
      expect(screen.getByRole('option', { name: 'State One' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'District One' })).toBeNull();
      expect(screen.queryByRole('option', { name: 'The Network' })).toBeNull();
      const save = screen.getByRole('button', { name: messages.console.org.save });
      expect(save).toBeDisabled();
      fireEvent.change(parent, { target: { value: 's1' } });
      fireEvent.click(save);
      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: JSON.stringify({ known_as: 'district', parent_id: 's1' }),
          }),
        ),
      );
      expect(await screen.findByText(messages.console.org.saved)).toBeInTheDocument();
    });

    it('offers the network as the parent for a level-1 value', () => {
      renderForm(baseOrg, true, true, full);
      fireEvent.change(screen.getByLabelText(messages.console.org.known_as), {
        target: { value: 'state' },
      });
      expect(screen.getByRole('option', { name: 'The Network' })).toBeInTheDocument();
    });

    it('says when no org sits one level up', () => {
      renderForm(baseOrg, true, true, { knownAs: KNOWN_AS, parents: [PARENTS[0]!] });
      fireEvent.change(screen.getByLabelText(messages.console.org.known_as), {
        target: { value: 'district' },
      });
      expect(
        screen.getByText('No active organisation at Level 1 to sit under.'),
      ).toBeInTheDocument();
    });

    it('keeps value and parent read-only for an org with child orgs', () => {
      renderForm(baseOrg, true, true, { ...full, hasChildren: true });
      const field = screen.getByLabelText(messages.console.org.known_as);
      expect(field).toBeDisabled();
      expect(field).toHaveValue('Aggregator (Level 3)');
      expect(screen.getByText(messages.console.org.known_as_has_children)).toBeInTheDocument();
    });

    it('shows a key no longer configured as its own option', () => {
      renderForm(
        { ...baseOrg, known_as: 'retired_key', known_as_label: null, level: null },
        true,
        true,
        full,
      );
      expect(screen.getByLabelText(messages.console.org.known_as)).toHaveValue('retired_key');
    });
  });

  it('shows known_as read-only with the admin-only hint to an owner', () => {
    renderForm(baseOrg, true, false);
    const field = screen.getByLabelText(messages.console.org.known_as);
    expect(field).toBeDisabled();
    expect(field).toHaveValue('Aggregator (Level 3)');
    expect(screen.getByText(messages.console.org.known_as_admin_only)).toBeInTheDocument();
  });

  it('never sends known_as or parent_id when the value is unchanged', async () => {
    global.fetch = respond({ ...baseOrg, url: 'https://other.example' }, 200) as never;
    renderForm(baseOrg, true, true, { knownAs: KNOWN_AS, parents: PARENTS });
    fireEvent.change(screen.getByLabelText(messages.console.org.url), {
      target: { value: 'https://other.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.save }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: JSON.stringify({ url: 'https://other.example' }) }),
      ),
    );
  });

  it('lists known_as in the read-only view, and omits it for the root', () => {
    const { unmount } = renderForm(baseOrg, false, false);
    expect(screen.getByText(messages.console.org.known_as)).toBeInTheDocument();
    expect(screen.getByText('Aggregator (Level 3)')).toBeInTheDocument();
    unmount();
    renderForm(
      {
        ...baseOrg,
        org_type: 'network_facilitator',
        known_as: null,
        known_as_label: null,
        level: 0,
      },
      false,
      false,
    );
    expect(screen.queryByText(messages.console.org.known_as)).toBeNull();
  });

  it('shows the name-taken error when the API rejects a rename', async () => {
    global.fetch = respond({ error: { code: 'ORG_NAME_TAKEN' } }, 400) as never;
    renderForm(baseOrg, true, true);
    fireEvent.change(screen.getByLabelText(messages.console.org.name), {
      target: { value: 'Taken Name' },
    });
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.save }));
    expect(await screen.findByText(messages.console.errors.name_taken)).toBeInTheDocument();
  });
});
