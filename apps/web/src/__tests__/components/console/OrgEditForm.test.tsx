/**
 * Unit tests for OrgEditForm.
 *
 * Covers: owner editing vs read-only rendering (the Default org, and a
 * non-owner such as the network admin), the locations list (populated +
 * empty), description and domains display and editing (the
 * domains multi-select), a no-change submit (no
 * network call), a successful patch, a field-clearing patch, and an error
 * response.
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
  description: null,
  domains: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const DOMAINS = [
  { id: 'seeker', label: 'Seekers' },
  { id: 'provider', label: 'Providers' },
];

function renderForm(org: Org, editable: boolean, canEdit: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgEditForm org={org} editable={editable} canEdit={canEdit} domains={DOMAINS} />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('<OrgEditForm />', () => {
  const original = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    // Radix Popover (the domains multi-select) reads these; jsdom lacks them.
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    global.fetch = original;
  });

  it('renders every field as an input for the owner, the name included', () => {
    renderForm(baseOrg, true, true);
    expect(screen.getByLabelText(messages.console.org.name)).not.toBeDisabled();
    expect(screen.getByLabelText(messages.console.org.url)).toHaveValue('https://acme.example');
    expect(screen.getByLabelText(messages.console.org.description)).toHaveValue('');
    expect(screen.getByLabelText(messages.console.org.domains)).toHaveAttribute(
      'aria-haspopup',
      'listbox',
    );
    expect(screen.getByText(messages.console.org.domains_placeholder)).toBeInTheDocument();
    expect(screen.getByText('1 Main St, Bengaluru, KA')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: messages.console.org.save })).toBeInTheDocument();
    expect(screen.queryByText(messages.console.org.read_only)).toBeNull();
    expect(screen.queryByText(messages.console.org.details_owner_only)).toBeNull();
  });

  it('shows the Default org read-only, with no inputs or save button', () => {
    renderForm({ ...baseOrg, gst_number: null }, false, true);
    expect(screen.getByText(messages.console.org.read_only)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: messages.console.org.save })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Acme Org')).toBeInTheDocument();
    expect(screen.getByText('1 Main St, Bengaluru, KA')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows every detail read-only to a non-owner (the network admin)', () => {
    renderForm(
      { ...baseOrg, description: 'Line one\nLine two', domains: ['provider', 'seeker'] },
      true,
      false,
    );
    expect(screen.getByText(messages.console.org.details_owner_only)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByLabelText(messages.console.org.domains)).toBeNull();
    expect(screen.queryByRole('button', { name: messages.console.org.save })).toBeNull();
    expect(screen.getByText('Acme Org')).toBeInTheDocument();
    expect(screen.getByText(/Line one/)).toHaveClass('whitespace-pre-line');
    expect(screen.getByText('Providers, Seekers')).toBeInTheDocument();
  });

  it('shows "no description" and "not stated" when both are empty', () => {
    renderForm(baseOrg, true, false);
    expect(screen.getByText(messages.console.org.no_description)).toBeInTheDocument();
    expect(screen.getByText(messages.console.org.no_domains)).toBeInTheDocument();
  });

  it('shows an unknown domain id as-is', () => {
    renderForm({ ...baseOrg, domains: ['retired_domain'] }, true, false);
    expect(screen.getByText('retired_domain')).toBeInTheDocument();
  });

  it('shows "no locations" when a read-only org has none', () => {
    renderForm({ ...baseOrg, locations: [] }, false, false);
    expect(screen.getByText(messages.console.org.no_locations)).toBeInTheDocument();
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

  it('includes a renamed name in the patch', async () => {
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

  it('patches the description (trimmed) and the domains in configuration order', async () => {
    global.fetch = respond(
      { ...baseOrg, description: 'About Acme.', domains: ['seeker', 'provider'] },
      200,
    ) as never;
    renderForm(baseOrg, true, true);
    fireEvent.change(screen.getByLabelText(messages.console.org.description), {
      target: { value: '  About Acme.  ' },
    });
    // Picked in reverse order; sent in the network's order.
    fireEvent.click(screen.getByLabelText(messages.console.org.domains));
    fireEvent.click(await screen.findByRole('button', { name: 'Providers', exact: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Seekers', exact: true }));
    expect(screen.getByRole('button', { name: 'Remove Providers' })).toBeInTheDocument();
    // The counter counts what was typed, spaces included.
    expect(screen.getByText(/15\/1000/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.save }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ description: 'About Acme.', domains: ['seeker', 'provider'] }),
        }),
      ),
    );
  });

  it('sends null for a cleared description and [] for cleared domains', async () => {
    global.fetch = respond({ ...baseOrg, description: null, domains: [] }, 200) as never;
    renderForm({ ...baseOrg, description: 'Old', domains: ['seeker'] }, true, true);
    expect(screen.getByText('Seekers')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(messages.console.org.description), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Seekers' }));
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.save }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: JSON.stringify({ description: null, domains: [] }) }),
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
