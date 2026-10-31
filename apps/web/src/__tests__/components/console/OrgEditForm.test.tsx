/**
 * Unit tests for OrgEditForm.
 *
 * Renders against the repository's default org-registration schema, so the
 * schema-driven fields (website, GST number, domains) are the ones a default
 * deployment shows. Covers: owner editing vs read-only rendering (the Default
 * org, and a non-owner such as the network admin), fixed and schema fields in
 * one patch, clearing a schema field, schema checks before sending (pattern
 * message, GSTIN check character), server field errors, and the stored
 * GSTIN shown after save.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { RJSFSchema } from '@rjsf/utils';
import messages from '@/i18n/messages/en.json';
import type { Org } from '@aggregator-dpg/shared-primitives/user-org';
import { OrgEditForm } from '@/components/console/OrgEditForm';
import { applyNetworkDomains } from '@/lib/org-schema';
import defaultSchema from '../../../../../../config/schemas/aggregator/org-registration.v1.json';
import defaultUi from '../../../../../../config/schemas/aggregator/org-registration.v1.ui.json';

const ORG_SCHEMA = applyNetworkDomains(
  defaultSchema as unknown as RJSFSchema,
  defaultUi as Record<string, unknown>,
  [
    { id: 'seeker', label: 'Seekers' },
    { id: 'provider', label: 'Providers' },
  ],
);

const baseOrg: Org = {
  id: '00000000-0000-4000-8000-0000000000a1',
  slug: 'acme',
  name: 'Acme Org',
  org_type: 'aggregator',
  status: 'active',
  is_default: false,
  locations: [
    {
      geo: { type: 'Point', coordinates: [77, 12] },
      address: { streetAddress: '1 Main St', addressLocality: 'Bengaluru', addressRegion: 'KA' },
    },
  ],
  legal_name: 'Acme Private Ltd',
  description: null,
  profile: { website: 'https://acme.example.org' },
  profile_ref: 'org-registration.v1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function renderForm(
  org: Org,
  editable: boolean,
  canEdit: boolean,
  orgSchema: typeof ORG_SCHEMA | null = ORG_SCHEMA,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgEditForm org={org} editable={editable} canEdit={canEdit} orgSchema={orgSchema} />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

const save = () => fireEvent.click(screen.getByRole('button', { name: messages.console.org.save }));

/** The JSON body of the first PATCH sent. */
function sentBody(): unknown {
  const call = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
  return JSON.parse(String((call?.[1] as { body: string }).body));
}

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

  it('renders fixed inputs and the schema fields for the owner', () => {
    renderForm(baseOrg, true, true);
    expect(screen.getByLabelText(messages.console.org.name)).toHaveValue('Acme Org');
    expect(screen.getByLabelText(messages.console.org.legal_name)).toHaveValue('Acme Private Ltd');
    expect(screen.getByLabelText(messages.console.org.description)).toHaveValue('');
    // Drawn from the schema.
    expect(screen.getByLabelText(/Website/)).toHaveValue('https://acme.example.org');
    expect(screen.getByLabelText(/GST number/)).toHaveValue('');
    expect(screen.getByText('Domains')).toBeInTheDocument();
    expect(screen.getByText('1 Main St, Bengaluru, KA')).toBeInTheDocument();
    expect(screen.queryByText(messages.console.org.details_owner_only)).toBeNull();
  });

  it('shows the Default org read-only, with no inputs or save button', () => {
    renderForm(baseOrg, false, true);
    expect(screen.getByText(messages.console.org.read_only)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: messages.console.org.save })).toBeNull();
  });

  it('shows every detail read-only to a non-owner (the network admin)', () => {
    renderForm(
      {
        ...baseOrg,
        description: 'Line one\nLine two',
        profile: {
          website: 'https://acme.example.org',
          gst_number: '29ABCDE1234F1ZW',
          domains: ['provider', 'seeker'],
        },
      },
      true,
      false,
    );
    expect(screen.getByText(messages.console.org.details_owner_only)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: messages.console.org.save })).toBeNull();
    expect(screen.getByText('https://acme.example.org')).toBeInTheDocument();
    expect(screen.getByText('29ABCDE1234F1ZW')).toBeInTheDocument();
    expect(screen.getByText('Providers, Seekers')).toBeInTheDocument();
    expect(screen.getByText(/Line one/)).toHaveClass('whitespace-pre-line');
  });

  it('shows "—" for empty schema fields and "no description" when read-only', () => {
    renderForm({ ...baseOrg, profile: {} }, true, false);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(messages.console.org.no_description)).toBeInTheDocument();
  });

  it('still renders the fixed fields when the schema cannot be loaded', () => {
    renderForm(baseOrg, true, true, null);
    expect(screen.getByLabelText(messages.console.org.name)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Website/)).toBeNull();
  });

  it('skips the network call and reports saved when nothing changed', async () => {
    global.fetch = respond({}, 200) as never;
    renderForm(baseOrg, true, true);
    save();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(messages.console.org.saved),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends fixed fields and changed schema fields in one patch', async () => {
    global.fetch = respond(baseOrg, 200) as never;
    renderForm(baseOrg, true, true);
    fireEvent.change(screen.getByLabelText(messages.console.org.legal_name), {
      target: { value: 'New Legal Ltd' },
    });
    fireEvent.change(screen.getByLabelText(/Website/), {
      target: { value: 'https://new.example.org' },
    });
    save();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(sentBody()).toEqual({
      legal_name: 'New Legal Ltd',
      profile: { website: 'https://new.example.org' },
    });
  });

  it('sends null to clear a schema field', async () => {
    global.fetch = respond({ ...baseOrg, profile: {} }, 200) as never;
    renderForm(baseOrg, true, true);
    fireEvent.change(screen.getByLabelText(/Website/), { target: { value: '' } });
    save();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(sentBody()).toEqual({ profile: { website: null } });
  });

  it.each(['acme.example.org', 'http://acme.example.org'])(
    'refuses the website %s before sending, with the schema message',
    async (value) => {
      global.fetch = respond({}, 200) as never;
      renderForm(baseOrg, true, true);
      fireEvent.change(screen.getByLabelText(/Website/), { target: { value } });
      save();
      expect(
        await screen.findByText('Please enter a website starting with https://'),
      ).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(messages.console.org.fix_fields);
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it('refuses a GSTIN with a wrong check character before sending', async () => {
    global.fetch = respond({}, 200) as never;
    renderForm(baseOrg, true, true);
    fireEvent.change(screen.getByLabelText(/GST number/), { target: { value: '29ABCDE1234F1Z5' } });
    save();
    expect(await screen.findByText('Please enter a valid GSTIN.')).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows the stored, upper-cased GSTIN after saving', async () => {
    global.fetch = respond(
      { ...baseOrg, profile: { ...baseOrg.profile, gst_number: '29ABCDE1234F1ZW' } },
      200,
    ) as never;
    renderForm(baseOrg, true, true);
    const gst = screen.getByLabelText(/GST number/);
    fireEvent.change(gst, { target: { value: '29abcde1234f1zw' } });
    save();
    await waitFor(() => expect(gst).toHaveValue('29ABCDE1234F1ZW'));
    expect(sentBody()).toEqual({ profile: { gst_number: '29abcde1234f1zw' } });
  });

  it('picks domains from the multi-select and sends them', async () => {
    global.fetch = respond(baseOrg, 200) as never;
    const { container } = renderForm(baseOrg, true, true);
    const trigger = container.querySelector('button[aria-haspopup="listbox"]') as HTMLElement;
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Seekers', exact: true }));
    save();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(sentBody()).toEqual({ profile: { domains: ['seeker'] } });
  });

  it('shows the server field errors under the matching schema fields', async () => {
    global.fetch = respond(
      {
        error: {
          code: 'SCHEMA_VALIDATION',
          fields: { field_errors: { gst_number: 'Server says no.' } },
        },
      },
      400,
    ) as never;
    renderForm(baseOrg, true, true);
    fireEvent.change(screen.getByLabelText(/GST number/), { target: { value: '27AAPFU0939F1ZV' } });
    save();
    expect(await screen.findByText('Server says no.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(messages.console.org.fix_fields);
  });

  it('shows the name-taken error when the API rejects a rename', async () => {
    global.fetch = respond({ error: { code: 'ORG_NAME_TAKEN' } }, 409) as never;
    renderForm(baseOrg, true, true);
    fireEvent.change(screen.getByLabelText(messages.console.org.name), {
      target: { value: 'Taken Name' },
    });
    save();
    expect(await screen.findByText(messages.console.errors.name_taken)).toBeInTheDocument();
  });
});
