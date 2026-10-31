/**
 * Unit tests for OrgEditForm.
 *
 * Renders against the repository's default org-registration schema, so the
 * schema-driven fields (website, GST number, domains) are the ones a default
 * deployment shows. Covers: the owner's form (fixed and schema fields in one
 * patch, clearing a schema field, schema checks before sending, server field
 * errors, the stored GSTIN after save), the "known as" value (the network
 * admin's only: choices at the depth, never a parent, page refresh, newer
 * values after a move, a key no longer configured, the depth error), and
 * read-only rendering (the Default org, an org below the viewer's own, a
 * non-owner).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { RJSFSchema } from '@rjsf/utils';
import messages from '@/i18n/messages/en.json';
import type { Org } from '@aggregator-dpg/shared-primitives/user-org';
import { applyNetworkDomains } from '@/lib/org-schema';
import defaultSchema from '../../../../../../config/schemas/aggregator/org-registration.v1.json';
import defaultUi from '../../../../../../config/schemas/aggregator/org-registration.v1.ui.json';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { OrgEditForm } from '@/components/console/OrgEditForm';

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
  known_as: 'aggregator',
  known_as_name: 'Aggregator',
  depth: 3,
  parent_id: 'd1',
  parent_name: null,
  description: null,
  profile: { website: 'https://acme.example.org' },
  profile_ref: 'org-registration.v1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

/** Values allowed at the org's depth, as the page passes them. */
const KNOWN_AS = [
  { key: 'aggregator', name: 'Aggregator' },
  { key: 'district', name: 'District' },
];

interface Viewer {
  editable?: boolean;
  /** The org's owner. */
  canEdit?: boolean;
  /** The network admin. */
  canSetKnownAs?: boolean;
  knownAs?: typeof KNOWN_AS;
  orgSchema?: typeof ORG_SCHEMA | null;
}

const OWNER: Viewer = { editable: true, canEdit: true };
const ADMIN: Viewer = { editable: true, canSetKnownAs: true, knownAs: KNOWN_AS };

function form(org: Org, v: Viewer) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgEditForm
        org={org}
        editable={v.editable ?? false}
        canEdit={v.canEdit ?? false}
        canSetKnownAs={v.canSetKnownAs ?? false}
        knownAsOptions={v.knownAs ?? []}
        orgSchema={v.orgSchema === undefined ? ORG_SCHEMA : v.orgSchema}
      />
    </NextIntlClientProvider>
  );
}

const renderForm = (org: Org, v: Viewer) => render(form(org, v));

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

  describe('the owner', () => {
    it('renders fixed inputs and the schema fields', () => {
      renderForm(baseOrg, OWNER);
      expect(screen.getByLabelText(messages.console.org.name)).toHaveValue('Acme Org');
      expect(screen.getByLabelText(messages.console.org.legal_name)).toHaveValue(
        'Acme Private Ltd',
      );
      expect(screen.getByLabelText(messages.console.org.description)).toHaveValue('');
      expect(screen.getByLabelText(/Website/)).toHaveValue('https://acme.example.org');
      expect(screen.getByLabelText(/GST number/)).toHaveValue('');
      expect(screen.getByText('Domains')).toBeInTheDocument();
      expect(screen.getByText('1 Main St, Bengaluru, KA')).toBeInTheDocument();
    });

    it('shows known_as read-only with the admin-only hint', () => {
      renderForm(baseOrg, OWNER);
      const field = screen.getByLabelText(messages.console.org.known_as);
      expect(field).toBeDisabled();
      expect(field).toHaveValue('Aggregator');
      expect(screen.getByText(messages.console.org.known_as_admin_only)).toBeInTheDocument();
    });

    it('skips the network call and reports saved when nothing changed', async () => {
      global.fetch = respond({}, 200) as never;
      renderForm(baseOrg, OWNER);
      save();
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(messages.console.org.saved),
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('sends fixed fields and changed schema fields in one patch, never known_as', async () => {
      global.fetch = respond(baseOrg, 200) as never;
      renderForm(baseOrg, OWNER);
      fireEvent.change(screen.getByLabelText(messages.console.org.name), {
        target: { value: 'Acme Renamed' },
      });
      fireEvent.change(screen.getByLabelText(messages.console.org.legal_name), {
        target: { value: 'New Legal Ltd' },
      });
      fireEvent.change(screen.getByLabelText(/Website/), {
        target: { value: 'https://new.example.org' },
      });
      save();
      await waitFor(() => expect(global.fetch).toHaveBeenCalled());
      expect(sentBody()).toEqual({
        name: 'Acme Renamed',
        legal_name: 'New Legal Ltd',
        profile: { website: 'https://new.example.org' },
      });
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it('sends null to clear a schema field', async () => {
      global.fetch = respond({ ...baseOrg, profile: {} }, 200) as never;
      renderForm(baseOrg, OWNER);
      fireEvent.change(screen.getByLabelText(/Website/), { target: { value: '' } });
      save();
      await waitFor(() => expect(global.fetch).toHaveBeenCalled());
      expect(sentBody()).toEqual({ profile: { website: null } });
    });

    it.each(['acme.example.org', 'http://acme.example.org'])(
      'refuses the website %s before sending, with the schema message',
      async (value) => {
        global.fetch = respond({}, 200) as never;
        renderForm(baseOrg, OWNER);
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
      renderForm(baseOrg, OWNER);
      fireEvent.change(screen.getByLabelText(/GST number/), {
        target: { value: '29ABCDE1234F1Z5' },
      });
      save();
      expect(await screen.findByText('Please enter a valid GSTIN.')).toBeInTheDocument();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('shows the stored, upper-cased GSTIN after saving', async () => {
      global.fetch = respond(
        {
          ...baseOrg,
          profile: { ...baseOrg.profile, gst_number: '29ABCDE1234F1ZW' },
          updated_at: '2026-01-02T00:00:00Z',
        },
        200,
      ) as never;
      renderForm(baseOrg, OWNER);
      const gst = screen.getByLabelText(/GST number/);
      fireEvent.change(gst, { target: { value: '29abcde1234f1zw' } });
      save();
      await waitFor(() => expect(gst).toHaveValue('29ABCDE1234F1ZW'));
      expect(sentBody()).toEqual({ profile: { gst_number: '29abcde1234f1zw' } });
    });

    it('picks domains from the multi-select and sends them', async () => {
      global.fetch = respond(baseOrg, 200) as never;
      const { container } = renderForm(baseOrg, OWNER);
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
      renderForm(baseOrg, OWNER);
      fireEvent.change(screen.getByLabelText(/GST number/), {
        target: { value: '27AAPFU0939F1ZV' },
      });
      save();
      expect(await screen.findByText('Server says no.')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(messages.console.org.fix_fields);
    });

    it('shows the name-taken error when the API rejects a rename', async () => {
      global.fetch = respond({ error: { code: 'ORG_NAME_TAKEN' } }, 409) as never;
      renderForm(baseOrg, OWNER);
      fireEvent.change(screen.getByLabelText(messages.console.org.name), {
        target: { value: 'Taken Name' },
      });
      save();
      expect(await screen.findByText(messages.console.errors.name_taken)).toBeInTheDocument();
    });

    it('still renders the fixed fields when the schema cannot be loaded', () => {
      renderForm(baseOrg, { ...OWNER, orgSchema: null });
      expect(screen.getByLabelText(messages.console.org.name)).toBeInTheDocument();
      expect(screen.queryByLabelText(/Website/)).toBeNull();
    });
  });

  describe('known_as (network admin)', () => {
    it('offers the values allowed at the depth, and the details read-only', () => {
      renderForm(baseOrg, ADMIN);
      const select = screen.getByLabelText(messages.console.org.known_as);
      expect(select).toHaveValue('aggregator');
      expect(screen.getByRole('option', { name: 'District' })).toBeInTheDocument();
      expect(screen.queryByLabelText(messages.console.orgs.col_parent)).toBeNull();
      expect(screen.getByText(messages.console.org.details_owner_only)).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.getByText('https://acme.example.org')).toBeInTheDocument();
    });

    it('sends only the new value, never a parent or a detail', async () => {
      global.fetch = respond(
        { ...baseOrg, known_as: 'district', known_as_name: 'District' },
        200,
      ) as never;
      renderForm(baseOrg, ADMIN);
      fireEvent.change(screen.getByLabelText(messages.console.org.known_as), {
        target: { value: 'district' },
      });
      save();
      await waitFor(() => expect(global.fetch).toHaveBeenCalled());
      expect(sentBody()).toEqual({ known_as: 'district' });
      expect(await screen.findByText(messages.console.org.saved)).toBeInTheDocument();
    });

    it('refreshes the page after a save so the rest of the page follows', async () => {
      global.fetch = respond(
        { ...baseOrg, known_as: 'district', known_as_name: 'District' },
        200,
      ) as never;
      renderForm(baseOrg, ADMIN);
      fireEvent.change(screen.getByLabelText(messages.console.org.known_as), {
        target: { value: 'district' },
      });
      save();
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it('never sends known_as when the value is unchanged', async () => {
      global.fetch = respond({}, 200) as never;
      renderForm(baseOrg, ADMIN);
      save();
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(messages.console.org.saved),
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('shows the newer values the page passes after a move', () => {
      const { rerender } = renderForm(
        { ...baseOrg, known_as: 'district', known_as_name: 'District', depth: 2 },
        ADMIN,
      );
      const moved: Org = {
        ...baseOrg,
        known_as: 'training_partner',
        known_as_name: 'Training Partner',
        depth: 3,
        parent_id: 'p2',
        updated_at: '2026-02-01T00:00:00Z',
      };
      const atDepth3 = [
        { key: 'aggregator', name: 'Aggregator' },
        { key: 'training_partner', name: 'Training Partner' },
      ];
      rerender(form(moved, { ...ADMIN, knownAs: atDepth3 }));
      expect(screen.getByLabelText(messages.console.org.known_as)).toHaveValue('training_partner');
      expect(screen.queryByText(messages.console.org.known_as_not_allowed)).toBeNull();
    });

    it('shows a key no longer configured as the raw key with a note', () => {
      renderForm({ ...baseOrg, known_as: 'retired_key', known_as_name: null }, ADMIN);
      expect(screen.getByLabelText(messages.console.org.known_as)).toHaveValue('retired_key');
      expect(screen.getByRole('option', { name: 'retired_key' })).toBeInTheDocument();
      expect(screen.getByText(messages.console.org.known_as_not_allowed)).toBeInTheDocument();
    });

    it('shows the API message when the value is not allowed', async () => {
      global.fetch = respond({ error: { code: 'KNOWN_AS_DEPTH' } }, 400) as never;
      renderForm(baseOrg, ADMIN);
      fireEvent.change(screen.getByLabelText(messages.console.org.known_as), {
        target: { value: 'district' },
      });
      save();
      expect(await screen.findByText(messages.console.errors.known_as_depth)).toBeInTheDocument();
    });

    it('lets a network admin who owns the org edit the details too', async () => {
      global.fetch = respond(baseOrg, 200) as never;
      renderForm(baseOrg, { ...ADMIN, canEdit: true });
      fireEvent.change(screen.getByLabelText(messages.console.org.legal_name), {
        target: { value: 'Own Ltd' },
      });
      fireEvent.change(screen.getByLabelText(messages.console.org.known_as), {
        target: { value: 'district' },
      });
      save();
      await waitFor(() => expect(global.fetch).toHaveBeenCalled());
      expect(sentBody()).toEqual({ legal_name: 'Own Ltd', known_as: 'district' });
    });
  });

  describe('read-only', () => {
    it('says the Default org is not editable, with no inputs or save button', () => {
      renderForm({ ...baseOrg, is_default: true }, { canEdit: true });
      expect(screen.getByText(messages.console.org.read_only)).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('button', { name: messages.console.org.save })).toBeNull();
    });

    it('shows an org below the viewer read-only, with no note', () => {
      renderForm(baseOrg, { editable: false });
      expect(screen.queryByText(messages.console.org.read_only)).toBeNull();
      expect(screen.queryByText(messages.console.org.details_owner_only)).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('shows every detail read-only to a non-owner without the known_as choice', () => {
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
        { editable: true },
      );
      expect(screen.getByText(messages.console.org.details_owner_only)).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.getByText('Aggregator')).toBeInTheDocument();
      expect(screen.getByText('https://acme.example.org')).toBeInTheDocument();
      expect(screen.getByText('29ABCDE1234F1ZW')).toBeInTheDocument();
      expect(screen.getByText('Providers, Seekers')).toBeInTheDocument();
      expect(screen.getByText(/Line one/)).toHaveClass('whitespace-pre-line');
    });

    it('omits known_as for the root, and shows "—" and "no description" when empty', () => {
      renderForm(
        { ...baseOrg, known_as: null, known_as_name: null, depth: 0, profile: {} },
        { editable: false },
      );
      expect(screen.queryByText(messages.console.org.known_as)).toBeNull();
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
      expect(screen.getByText(messages.console.org.no_description)).toBeInTheDocument();
    });
  });
});
