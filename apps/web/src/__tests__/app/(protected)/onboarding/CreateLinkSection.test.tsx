/**
 * Tests for `CreateLinkSection`: the create-link form, its derived domain and
 * registration-mode defaults, the location-based prefill, the disabled-submit
 * blockers list, slug/title derivation, tag de-duplication, and the create
 * success/failure paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { ApiRegistrationLink } from '@/services/onboarding.service';

const { pushMock, searchParamsRef } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  // Mutable so a test can set `?new=` before rendering YourLinksBody.
  searchParamsRef: { current: new URLSearchParams() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  // YourLinksBody reads `?new=` to highlight a freshly-created draft.
  useSearchParams: () => searchParamsRef.current,
}));

const { useActivateLink, useCreateLink, useDeactivateLink, useRegistrationLinks, useUpdateLink } =
  vi.hoisted(() => ({
    useActivateLink: vi.fn(),
    useCreateLink: vi.fn(),
    useDeactivateLink: vi.fn(),
    useRegistrationLinks: vi.fn(),
    useUpdateLink: vi.fn(),
  }));
vi.mock('@/hooks/useOnboarding', () => ({
  useActivateLink: () => useActivateLink(),
  useCreateLink: () => useCreateLink(),
  useDeactivateLink: () => useDeactivateLink(),
  useRegistrationLinks: (...args: unknown[]) => useRegistrationLinks(...args),
  useUpdateLink: () => useUpdateLink(),
}));

const { useProfile, useProfileRaw } = vi.hoisted(() => ({
  useProfile: vi.fn(),
  useProfileRaw: vi.fn(),
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => useProfile(),
  useProfileRaw: () => useProfileRaw(),
}));

const { useAggregatorConfig } = vi.hoisted(() => ({ useAggregatorConfig: vi.fn() }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => useAggregatorConfig(),
}));

// The QR is generated client-side (#650). Mock so the modal's toDataURL is
// controllable — resolve a stub PNG by default, reject in the error test.
const { qrToDataURL } = vi.hoisted(() => ({ qrToDataURL: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toDataURL: qrToDataURL } }));

import { CreateLinkSection } from '@/app/(protected)/onboarding/_components/registration-links/CreateLinkSection';

const testMessages = {
  onboarding: messages.onboarding,
  regmode: { form: 'Form', voice: 'Voice' },
};

function renderCreate() {
  return render(
    <NextIntlClientProvider locale="en" messages={testMessages}>
      <CreateLinkSection />
    </NextIntlClientProvider>,
  );
}

const cfg = {
  domains: [{ id: 'seeker', label: 'Seeker', plural_label: 'Seekers' }],
  registration_modes: {
    form: {
      label_i18n_key: 'regmode.form',
      submission_shape: 'account_and_profile' as const,
      public_hint_i18n_key: null,
    },
    voice: {
      label_i18n_key: 'regmode.voice',
      submission_shape: 'account_only' as const,
      public_hint_i18n_key: null,
    },
  },
};

function baseLink(overrides: Partial<ApiRegistrationLink> = {}): ApiRegistrationLink {
  return {
    link_id: 'link-1',
    slug: 'dharwad-drive',
    domain: 'seeker',
    status: 'draft',
    registration_mode: 'form',
    context: {},
    expires_at: null,
    public_url: null,
    qr_url: null,
    qr_expires_at: null,
    metrics: { total: 0, passed: 0, failed: 0, skipped: 0 },
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('<CreateLinkSection />', () => {
  const createMutateAsync = vi.fn();
  const updateMutateAsync = vi.fn();
  const activateMutate = vi.fn();
  const deactivateMutate = vi.fn();

  beforeEach(() => {
    pushMock.mockClear();
    createMutateAsync.mockReset();
    updateMutateAsync.mockReset();
    useAggregatorConfig.mockReturnValue({ data: cfg });
    useProfile.mockReturnValue({ data: { org: 'Acme Org' } });
    useProfileRaw.mockReturnValue({ data: { type: 'seeker' } });
    useCreateLink.mockReturnValue({ mutateAsync: createMutateAsync, isPending: false });
    useUpdateLink.mockReturnValue({ mutateAsync: updateMutateAsync, isPending: false });
    useActivateLink.mockReturnValue({ mutate: activateMutate, isPending: false });
    useDeactivateLink.mockReturnValue({ mutate: deactivateMutate, isPending: false });
    useRegistrationLinks.mockReturnValue({ data: [], isLoading: false, error: null });
  });

  afterEach(() => vi.clearAllMocks());

  it('pins the read-only domain field to the org name + aggregator-registered domain', () => {
    renderCreate();
    expect(screen.getByDisplayValue('Acme Org')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Seekers')).toBeInTheDocument();
  });

  it('lists the remaining unmet blockers and keeps Create disabled when required fields are empty', () => {
    renderCreate();
    expect(screen.getByText('To create the link:')).toBeInTheDocument();
    expect(screen.getByText('Enter the State.')).toBeInTheDocument();
    expect(screen.getByText('Enter the District.')).toBeInTheDocument();
    expect(screen.getByText('Enter the Event.')).toBeInTheDocument();
    // domain + registration_mode are auto-pinned by mount-time effects, so
    // those two blockers should already be cleared.
    expect(screen.queryByText('Domain is not set.')).not.toBeInTheDocument();
    expect(screen.queryByText('Select a form type.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled();
  });

  it('prefills state/district/event location from the aggregator profile address at mount', () => {
    useProfileRaw.mockReturnValue({
      data: {
        type: 'seeker',
        locations: [{ address: { addressRegion: 'Karnataka', addressLocality: 'Dharwad' } }],
      },
    });
    renderCreate();
    expect(screen.getByPlaceholderText('State')).toHaveValue('Karnataka');
    expect(screen.getByPlaceholderText('District')).toHaveValue('Dharwad');
    expect(screen.getByPlaceholderText('City or venue')).toHaveValue('Dharwad');
    // Only the Event field remains unmet now.
    expect(screen.queryByText('Enter the State.')).not.toBeInTheDocument();
    expect(screen.queryByText('Enter the District.')).not.toBeInTheDocument();
    expect(screen.getByText('Enter the Event.')).toBeInTheDocument();
  });

  it('clears the blockers and enables Create once the required fields are filled', async () => {
    const user = userEvent.setup();
    renderCreate();
    await user.type(screen.getByPlaceholderText('State'), 'Karnataka');
    await user.type(screen.getByPlaceholderText('District'), 'Dharwad');
    await user.type(screen.getByPlaceholderText('Campaign or event name'), 'Field Drive');
    expect(screen.queryByText('To create the link:')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create link' })).toBeEnabled();
  });

  it('creates a link with de-duplicated tags, a derived slug/title, and resets the form on success', async () => {
    createMutateAsync.mockResolvedValue(baseLink());
    const user = userEvent.setup();
    renderCreate();

    await user.type(screen.getByPlaceholderText('State'), 'Karnataka');
    await user.type(screen.getByPlaceholderText('District'), 'Dharwad');
    await user.type(screen.getByPlaceholderText('Campaign or event name'), 'Field Drive');
    fireEvent.change(document.querySelector('input[type="date"]') as HTMLInputElement, {
      target: { value: '2026-03-15' },
    });
    await user.type(
      screen.getByPlaceholderText('Comma-separated, e.g. priority, dharwad-drive'),
      'urgent, urgent, delhi',
    );

    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(createMutateAsync).toHaveBeenCalledTimes(1);
    const input = createMutateAsync.mock.calls[0]![0];
    expect(input.domain).toBe('seeker');
    expect(input.status).toBe('draft');
    expect(input.registration_mode).toBe('form');
    expect(input.slug).toBe('dharwad-field-drive-mar26');
    expect(input.title).toBe('Dharwad Field Drive — Mar 2026');
    expect(input.context.org_name).toBe('Acme Org');
    expect(input.context.state).toBe('Karnataka');
    expect(input.context.district).toBe('Dharwad');
    expect(input.context.lever_event).toBe('Field Drive');
    expect(input.context.tags).toEqual(['urgent', 'delhi']);

    expect(await screen.findByText('Registration link created')).toBeInTheDocument();
    // Navigates to the list with `?new=<id>` so the fresh draft is highlighted.
    expect(pushMock).toHaveBeenCalledWith('/onboarding?new=link-1');
    // Form resets after a successful create.
    expect(screen.getByPlaceholderText('State')).toHaveValue('');
  });

  it('omits the slug when the district slugifies to an empty string', async () => {
    createMutateAsync.mockResolvedValue(baseLink());
    const user = userEvent.setup();
    renderCreate();

    await user.type(screen.getByPlaceholderText('State'), 'Karnataka');
    await user.type(screen.getByPlaceholderText('District'), '###');
    await user.type(screen.getByPlaceholderText('Campaign or event name'), 'Field Drive');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    const input = createMutateAsync.mock.calls[0]![0];
    expect(input.slug).toBeUndefined();
  });

  it('surfaces the mutation error inline when create fails', async () => {
    createMutateAsync.mockRejectedValue(new Error('Domain mismatch'));
    const user = userEvent.setup();
    renderCreate();

    await user.type(screen.getByPlaceholderText('State'), 'Karnataka');
    await user.type(screen.getByPlaceholderText('District'), 'Dharwad');
    await user.type(screen.getByPlaceholderText('Campaign or event name'), 'Field Drive');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(await screen.findByText('Domain mismatch')).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('changes the registration mode via the select and reflects it on submit', async () => {
    createMutateAsync.mockResolvedValue(baseLink());
    const user = userEvent.setup();
    renderCreate();

    await user.type(screen.getByPlaceholderText('State'), 'Karnataka');
    await user.type(screen.getByPlaceholderText('District'), 'Dharwad');
    await user.type(screen.getByPlaceholderText('Campaign or event name'), 'Drive');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'voice' } });
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(createMutateAsync.mock.calls[0]![0].registration_mode).toBe('voice');
  });

  it('sets the domain once the profile type loads after the first render', () => {
    useProfileRaw.mockReturnValue({ data: undefined });
    const { rerender } = renderCreate();
    expect(screen.getByText('Domain is not set.')).toBeInTheDocument();

    useProfileRaw.mockReturnValue({ data: { type: 'seeker' } });
    rerender(
      <NextIntlClientProvider locale="en" messages={testMessages}>
        <CreateLinkSection />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText('Domain is not set.')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Seekers')).toBeInTheDocument();
  });

  it('defaults the registration mode to the first mode when the config has no `form` mode', async () => {
    createMutateAsync.mockResolvedValue(baseLink());
    useAggregatorConfig.mockReturnValue({
      data: { ...cfg, registration_modes: { voice: cfg.registration_modes.voice } },
    });
    const user = userEvent.setup();
    renderCreate();

    await user.type(screen.getByPlaceholderText('State'), 'Karnataka');
    await user.type(screen.getByPlaceholderText('District'), 'Dharwad');
    await user.type(screen.getByPlaceholderText('Campaign or event name'), 'Drive');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(createMutateAsync.mock.calls[0]![0].registration_mode).toBe('voice');
  });

  it('lists the form type as missing while the config has no registration modes', () => {
    useAggregatorConfig.mockReturnValue({ data: { ...cfg, registration_modes: {} } });
    renderCreate();
    expect(screen.getByText('Select a form type.')).toBeInTheDocument();
  });

  it('prefills the event location from the street address when there is no locality', () => {
    useProfileRaw.mockReturnValue({
      data: { type: 'seeker', locations: [{ address: { streetAddress: '12 MG Road' } }] },
    });
    renderCreate();
    expect(screen.getByPlaceholderText('City or venue')).toHaveValue('12 MG Road');
    expect(screen.getByPlaceholderText('State')).toHaveValue('');
  });

  it('keeps a value typed before the profile address loads', async () => {
    useProfileRaw.mockReturnValue({ data: { type: 'seeker' } });
    const user = userEvent.setup();
    const { rerender } = renderCreate();
    await user.type(screen.getByPlaceholderText('State'), 'Goa');

    useProfileRaw.mockReturnValue({
      data: {
        type: 'seeker',
        locations: [{ address: { addressRegion: 'Karnataka', addressLocality: 'Dharwad' } }],
      },
    });
    rerender(
      <NextIntlClientProvider locale="en" messages={testMessages}>
        <CreateLinkSection />
      </NextIntlClientProvider>,
    );
    expect(screen.getByPlaceholderText('State')).toHaveValue('Goa');
    expect(screen.getByPlaceholderText('District')).toHaveValue('Dharwad');
  });

  it('resets the form to the profile address after a create', async () => {
    createMutateAsync.mockResolvedValue(baseLink());
    useProfileRaw.mockReturnValue({
      data: {
        type: 'seeker',
        locations: [{ address: { addressRegion: 'Karnataka', addressLocality: 'Dharwad' } }],
      },
    });
    const user = userEvent.setup();
    renderCreate();
    await user.clear(screen.getByPlaceholderText('State'));
    await user.type(screen.getByPlaceholderText('State'), 'Goa');
    await user.type(screen.getByPlaceholderText('Campaign or event name'), 'Drive');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(createMutateAsync.mock.calls[0]![0].context.state).toBe('Goa');
    await waitFor(() => expect(screen.getByPlaceholderText('State')).toHaveValue('Karnataka'));
    expect(screen.getByPlaceholderText('Campaign or event name')).toHaveValue('');
  });

  it('shows a plain string when create fails with a non-Error value', async () => {
    createMutateAsync.mockRejectedValue('network down');
    const user = userEvent.setup();
    renderCreate();
    await user.type(screen.getByPlaceholderText('State'), 'Karnataka');
    await user.type(screen.getByPlaceholderText('District'), 'Dharwad');
    await user.type(screen.getByPlaceholderText('Campaign or event name'), 'Drive');
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByText('network down')).toBeInTheDocument();
  });

  it('hides the created toast after it has been shown', async () => {
    createMutateAsync.mockResolvedValue(baseLink());
    const user = userEvent.setup();
    renderCreate();
    await user.type(screen.getByPlaceholderText('State'), 'Karnataka');
    await user.type(screen.getByPlaceholderText('District'), 'Dharwad');
    await user.type(screen.getByPlaceholderText('Campaign or event name'), 'Drive');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(await screen.findByText('Registration link created')).toBeInTheDocument();
    await waitFor(
      () => expect(screen.queryByText('Registration link created')).not.toBeInTheDocument(),
      { timeout: 4000 },
    );
  });
});
