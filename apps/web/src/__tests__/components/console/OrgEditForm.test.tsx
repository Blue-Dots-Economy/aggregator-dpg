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
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function renderForm(org: Org, editable: boolean, canRename: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgEditForm org={org} editable={editable} canRename={canRename} />
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
