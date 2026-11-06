/**
 * Tests for `YourLinksBody` and its `LinkCard`: loading/error/empty states,
 * draft vs live vs retired rendering, the inline edit flow, activate/deactivate
 * actions, the copy-link clipboard action, the QR preview, and the malformed
 * `public_url` branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
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

import { YourLinksBody } from '@/app/(protected)/onboarding/_components/registration-links/YourLinksBody';

const testMessages = {
  onboarding: messages.onboarding,
  regmode: { form: 'Form', voice: 'Voice' },
};

function renderLinks() {
  return render(
    <NextIntlClientProvider locale="en" messages={testMessages}>
      <YourLinksBody />
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

describe('<YourLinksBody />', () => {
  const updateMutateAsync = vi.fn();
  const activateMutate = vi.fn();
  const deactivateMutate = vi.fn();

  beforeEach(() => {
    updateMutateAsync.mockReset();
    activateMutate.mockClear();
    deactivateMutate.mockClear();
    searchParamsRef.current = new URLSearchParams();
    qrToDataURL.mockReset().mockResolvedValue('data:image/png;base64,STUB');
    // jsdom has no scrollIntoView; the highlight effect calls it.
    Element.prototype.scrollIntoView = vi.fn();
    // jsdom doesn't implement <dialog> showModal/close — the QR preview uses
    // them. Reflect `open` so role queries see the (now-open) dialog's contents.
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    });
    useAggregatorConfig.mockReturnValue({ data: cfg });
    useProfileRaw.mockReturnValue({ data: { type: 'seeker' } });
    useProfile.mockReturnValue({ data: { org: 'Acme Org' } });
    useCreateLink.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    useUpdateLink.mockReturnValue({ mutateAsync: updateMutateAsync, isPending: false });
    useActivateLink.mockReturnValue({ mutate: activateMutate, isPending: false });
    useDeactivateLink.mockReturnValue({ mutate: deactivateMutate, isPending: false });
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn() },
        configurable: true,
      });
    }
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  });

  afterEach(() => vi.clearAllMocks());

  it('shows a loading state', () => {
    useRegistrationLinks.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderLinks();
    expect(screen.getByText('Loading links…')).toBeInTheDocument();
  });

  it('shows an error state', () => {
    useRegistrationLinks.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('links unavailable'),
    });
    renderLinks();
    expect(screen.getByText('links unavailable')).toBeInTheDocument();
  });

  it('shows an empty state scoped to the aggregator type', () => {
    useRegistrationLinks.mockReturnValue({ data: [], isLoading: false, error: null });
    renderLinks();
    expect(screen.getByText('No seeker links yet. Create one above.')).toBeInTheDocument();
  });

  it('renders the active-count and type-pill badges alongside each link card', () => {
    useRegistrationLinks.mockReturnValue({
      data: [
        baseLink({ link_id: 'l1', status: 'live', context: { title: 'Live One' } }),
        baseLink({ link_id: 'l2', status: 'draft', context: { title: 'Draft One' } }),
      ],
      isLoading: false,
      error: null,
    });
    renderLinks();
    expect(screen.getByText('1 active')).toBeInTheDocument();
    expect(screen.getByText('seeker links')).toBeInTheDocument();
    expect(screen.getByText('Live One')).toBeInTheDocument();
    expect(screen.getByText('Draft One')).toBeInTheDocument();
  });

  it('scrolls the freshly-created draft into view when ?new= matches it', () => {
    searchParamsRef.current = new URLSearchParams('new=l2');
    useRegistrationLinks.mockReturnValue({
      data: [
        baseLink({ link_id: 'l1', status: 'live', context: { title: 'Live One' } }),
        baseLink({ link_id: 'l2', status: 'draft', context: { title: 'Draft One' } }),
      ],
      isLoading: false,
      error: null,
    });
    renderLinks();
    // The highlighted card scrolls itself into view; non-matching cards don't.
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    // A toast confirms the draft and points at "Make Live".
    expect(screen.getByText(/created as a draft/i)).toBeInTheDocument();
  });

  it('closes the draft toast on time even when the list re-renders while it shows', () => {
    vi.useFakeTimers();
    try {
      searchParamsRef.current = new URLSearchParams('new=l2');
      useRegistrationLinks.mockReturnValue({
        data: [baseLink({ link_id: 'l2', status: 'draft', context: { title: 'Draft One' } })],
        isLoading: false,
        error: null,
      });
      const { rerender } = renderLinks();
      expect(screen.getByText(/created as a draft/i)).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(2000));
      rerender(
        <NextIntlClientProvider locale="en" messages={testMessages}>
          <YourLinksBody />
        </NextIntlClientProvider>,
      );
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByText(/created as a draft/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('draft card: shows the draft notice and Edit + Make Live actions, and Make Live activates the link', async () => {
    const user = userEvent.setup();
    useRegistrationLinks.mockReturnValue({
      data: [baseLink({ context: { district: 'Dharwad', lever_event: 'Drive' } })],
      isLoading: false,
      error: null,
    });
    renderLinks();

    expect(screen.getByText('Public URL + QR appear after Make Live.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make Live' }));
    expect(activateMutate).toHaveBeenCalledWith('link-1');
  });

  it('draft card edit flow: validates required fields, saves a patch, and closes the editor on success', async () => {
    updateMutateAsync.mockResolvedValue(baseLink());
    const user = userEvent.setup();
    useRegistrationLinks.mockReturnValue({
      data: [
        baseLink({
          context: { state: 'Karnataka', district: 'Dharwad', lever_event: 'Drive' },
        }),
      ],
      isLoading: false,
      error: null,
    });
    renderLinks();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const districtInputs = screen.getAllByDisplayValue('Dharwad');
    await user.clear(districtInputs[districtInputs.length - 1]!);
    // Save Draft is disabled by the same required-field check while district
    // is empty, so the button never fires the mutation.
    expect(screen.getByRole('button', { name: 'Save Draft' })).toBeDisabled();
    expect(updateMutateAsync).not.toHaveBeenCalled();

    await user.type(districtInputs[districtInputs.length - 1]!, 'Belagavi');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const patch = updateMutateAsync.mock.calls[0]![0];
    expect(patch.id).toBe('link-1');
    expect(patch.patch.context.district).toBe('Belagavi');
    // Editor closes after a successful save.
    expect(screen.queryByRole('button', { name: 'Save Draft' })).not.toBeInTheDocument();
  });

  it('draft card edit flow: cancel discards changes and closes the editor', async () => {
    const user = userEvent.setup();
    useRegistrationLinks.mockReturnValue({
      data: [baseLink({ context: { state: 'K', district: 'D', lever_event: 'E' } })],
      isLoading: false,
      error: null,
    });
    renderLinks();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Save Draft' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Save Draft' })).not.toBeInTheDocument();
  });

  it('draft card edit flow: keeps the editor open and shows an error on save failure', async () => {
    updateMutateAsync.mockRejectedValue(new Error('conflict'));
    const user = userEvent.setup();
    useRegistrationLinks.mockReturnValue({
      data: [baseLink({ context: { state: 'K', district: 'D', lever_event: 'E' } })],
      isLoading: false,
      error: null,
    });
    renderLinks();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    expect(await screen.findByText('conflict')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Draft' })).toBeInTheDocument();
  });

  it('live card: renders the split public URL, copy/open/QR actions, and deactivates on click', async () => {
    const user = userEvent.setup();
    useRegistrationLinks.mockReturnValue({
      data: [
        baseLink({
          status: 'live',
          public_url: 'https://bluedots.example/acme/dharwad-drive',
          expires_at: new Date('2027-01-01').toISOString(),
        }),
      ],
      isLoading: false,
      error: null,
    });
    renderLinks();

    expect(screen.getByText('bluedots.example/')).toBeInTheDocument();
    expect(screen.getByText('acme/dharwad-drive')).toBeInTheDocument();
    expect(screen.getByTitle('View QR')).toBeInTheDocument();
    expect(screen.getByTitle('Open link')).toBeInTheDocument();
    expect(screen.getByText(/Expires/)).toBeInTheDocument();

    // #650: clicking the QR button opens the preview modal (no navigation).
    await user.click(screen.getByTitle('View QR'));
    expect(await screen.findByText('Registration QR')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // One copy affordance per card now: the icon inside the URL pill. The
    // labelled "Copy link" button that used to duplicate it is gone, so this
    // asserts a single match rather than picking the last of several.
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://bluedots.example/acme/dharwad-drive',
    );
    expect(await screen.findByTitle('Copied!')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(deactivateMutate).toHaveBeenCalledWith('link-1');
  });

  it('QR modal: Download generates from public_url and saves qr-<slug>.png', async () => {
    const user = userEvent.setup();
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    useRegistrationLinks.mockReturnValue({
      data: [
        baseLink({ status: 'live', public_url: 'https://bluedots.example/acme/dharwad-drive' }),
      ],
      isLoading: false,
      error: null,
    });
    renderLinks();

    await user.click(screen.getByTitle('View QR'));
    const download = await screen.findByRole('button', { name: /Download/ });
    await user.click(download);

    expect(qrToDataURL).toHaveBeenCalledWith(
      'https://bluedots.example/acme/dharwad-drive',
      expect.objectContaining({ width: 512 }),
    );
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('qr-dharwad-drive.png');
    expect(anchor.href).toContain('data:image/png');
    clickSpy.mockRestore();
  });

  it('QR modal: shows the error state and logs when generation fails', async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    qrToDataURL.mockRejectedValueOnce(new Error('boom'));
    useRegistrationLinks.mockReturnValue({
      data: [
        baseLink({ status: 'live', public_url: 'https://bluedots.example/acme/dharwad-drive' }),
      ],
      isLoading: false,
      error: null,
    });
    renderLinks();

    await user.click(screen.getByTitle('View QR'));
    expect(
      await screen.findByText("Couldn't generate the QR. Please try again."),
    ).toBeInTheDocument();
    expect(consoleSpy).toHaveBeenCalledWith('qr generation failed', expect.any(Error));
    consoleSpy.mockRestore();
  });

  it('QR modal: the close button closes the preview', async () => {
    const user = userEvent.setup();
    useRegistrationLinks.mockReturnValue({
      data: [
        baseLink({ status: 'live', public_url: 'https://bluedots.example/acme/dharwad-drive' }),
      ],
      isLoading: false,
      error: null,
    });
    renderLinks();

    await user.click(screen.getByTitle('View QR'));
    expect(await screen.findByRole('img', { name: 'Registration QR' })).toHaveAttribute(
      'src',
      'data:image/png;base64,STUB',
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Registration QR')).not.toBeInTheDocument();
  });

  it('live card: the copied mark clears after a short delay', async () => {
    const user = userEvent.setup();
    useRegistrationLinks.mockReturnValue({
      data: [baseLink({ status: 'live', public_url: 'https://bluedots.example/acme/d' })],
      isLoading: false,
      error: null,
    });
    renderLinks();

    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByTitle('Copied!')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTitle('Copied!')).not.toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('draft card edit flow: prefills from the context and sends every edited field', async () => {
    updateMutateAsync.mockResolvedValue(baseLink());
    const user = userEvent.setup();
    useRegistrationLinks.mockReturnValue({
      data: [
        baseLink({
          context: {
            state: 'Karnataka',
            district: 'Dharwad',
            lever_event: 'Drive',
            event_location: 'Hall',
            tags: ['a', 'b'],
            org_name: 'Acme Org',
            custom: 'kept',
          },
        }),
      ],
      isLoading: false,
      error: null,
    });
    renderLinks();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByDisplayValue('Karnataka'));
    await user.type(screen.getAllByRole('textbox')[0]!, 'Goa');
    await user.clear(screen.getByDisplayValue('Drive'));
    await user.type(screen.getAllByRole('textbox')[2]!, 'Camp');
    await user.clear(screen.getByDisplayValue('Hall'));
    await user.type(screen.getAllByRole('textbox')[3]!, 'Library');
    fireEvent.change(document.querySelector('input[type="date"]') as HTMLInputElement, {
      target: { value: '2026-03-15' },
    });
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const { patch } = updateMutateAsync.mock.calls[0]![0];
    expect(patch.slug).toBe('dharwad-camp-mar26');
    expect(patch.context).toEqual({
      state: 'Goa',
      district: 'Dharwad',
      lever_event: 'Camp',
      event_date: '2026-03-15',
      event_location: 'Library',
      tags: ['a', 'b'],
      org_name: 'Acme Org',
      custom: 'kept',
      title: 'Dharwad Camp — Mar 2026',
    });
  });

  it('draft card edit flow: shows a plain string when save fails with a non-Error value', async () => {
    updateMutateAsync.mockRejectedValue('conflict text');
    const user = userEvent.setup();
    useRegistrationLinks.mockReturnValue({
      data: [baseLink({ context: { state: 'K', district: 'D', lever_event: 'E' } })],
      isLoading: false,
      error: null,
    });
    renderLinks();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    expect(await screen.findByText('conflict text')).toBeInTheDocument();
  });

  it('live card: renders a malformed public_url as raw text instead of crashing', () => {
    useRegistrationLinks.mockReturnValue({
      data: [baseLink({ status: 'live', public_url: 'not a valid url' })],
      isLoading: false,
      error: null,
    });
    expect(() => renderLinks()).not.toThrow();
    expect(screen.getByText(/not a valid url/)).toBeInTheDocument();
  });

  it('retired card: shows the retired badge and no draft/live action buttons', () => {
    useRegistrationLinks.mockReturnValue({
      data: [baseLink({ status: 'retired', context: { title: 'Old Drive' } })],
      isLoading: false,
      error: null,
    });
    renderLinks();
    expect(screen.getByText('retired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make Live' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
  });

  it('falls back to district+lever_event, then to slug, when context.title is absent', () => {
    useRegistrationLinks.mockReturnValue({
      data: [
        baseLink({
          link_id: 'l-notitle',
          context: { district: 'Mysuru', lever_event: 'Kiosk' },
        }),
        baseLink({ link_id: 'l-slugonly', slug: 'fallback-slug', context: {} }),
      ],
      isLoading: false,
      error: null,
    });
    renderLinks();
    expect(screen.getByText('Mysuru Kiosk')).toBeInTheDocument();
    expect(screen.getByText('fallback-slug')).toBeInTheDocument();
  });

  it('defaults registration/verification counts to zero when metrics is absent', () => {
    const { metrics: _omit, ...withoutMetrics } = baseLink();
    useRegistrationLinks.mockReturnValue({
      data: [withoutMetrics as ApiRegistrationLink],
      isLoading: false,
      error: null,
    });
    renderLinks();
    expect(screen.getAllByText('0')).toHaveLength(2);
  });
});
