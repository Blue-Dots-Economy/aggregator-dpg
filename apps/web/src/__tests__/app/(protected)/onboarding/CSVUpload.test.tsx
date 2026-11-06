/**
 * Tests for `CSVUpload` (the bulk upload widget): file-type validation,
 * drag+drop, the attestation gate, the upload lifecycle (success / duplicate /
 * failure), the template-download redirect, and the participant type.
 *
 * `setTimeout`-driven UI (the success toast and the post-upload navigation
 * delay) is exercised by spying on `global.setTimeout` and invoking the
 * captured callback directly, which avoids fake timers fighting Testing
 * Library's async `findBy*`/`waitFor` polling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { BulkUploadStartUnreadError } from '@/services/onboarding.service';
import type * as OnboardingServiceModule from '@/services/onboarding.service';
import { ResponseShapeError } from '@/lib/response-shape-error';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

const { useBulkUpload, useRecentBulkUploads } = vi.hoisted(() => ({
  useBulkUpload: vi.fn(),
  useRecentBulkUploads: vi.fn(),
}));
vi.mock('@/hooks/useOnboarding', () => ({
  useBulkUpload: () => useBulkUpload(),
  useRecentBulkUploads: (...args: unknown[]) => useRecentBulkUploads(...args),
}));

const { useProfileRaw } = vi.hoisted(() => ({ useProfileRaw: vi.fn() }));
vi.mock('@/hooks/useProfile', () => ({
  useProfileRaw: () => useProfileRaw(),
}));

const cfg = {
  domains: [
    { id: 'seeker', label: 'Seeker', plural_label: 'Seekers' },
    { id: 'provider', label: 'Provider', plural_label: 'Providers' },
  ],
};
const { useAggregatorConfig } = vi.hoisted(() => ({ useAggregatorConfig: vi.fn() }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => useAggregatorConfig(),
  DEFAULT_AGGREGATOR_CONFIG: { domains: [{ id: 'seeker', plural_label: 'Seekers' }] },
}));

const { canMock } = vi.hoisted(() => ({ canMock: vi.fn((_c: string) => true) }));
vi.mock('@/lib/auth-context', () => ({
  useCan: () => canMock,
}));

const { errorsCsvUrl } = vi.hoisted(() => ({ errorsCsvUrl: vi.fn() }));
vi.mock('@/services/onboarding.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OnboardingServiceModule>()),
  onboardingService: { errorsCsvUrl: (...args: unknown[]) => errorsCsvUrl(...args) },
}));

import { CSVUpload } from '@/app/(protected)/onboarding/_components/bulk-upload/CSVUpload';

function renderUpload(props: Parameters<typeof CSVUpload>[0] = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
      <CSVUpload {...props} />
    </NextIntlClientProvider>,
  );
}

function makeCsv(name = 'roster.csv', content = 'name,phone\nA,123') {
  return new File([content], name, { type: 'text/csv' });
}

describe('<CSVUpload />', () => {
  const mutateAsync = vi.fn();
  const refetch = vi.fn();

  beforeEach(() => {
    pushMock.mockClear();
    mutateAsync.mockReset();
    refetch.mockClear();
    useAggregatorConfig.mockReturnValue({ data: cfg });
    useProfileRaw.mockReturnValue({ data: { type: 'seeker' } });
    useBulkUpload.mockReturnValue({ mutateAsync, isPending: false });
    useRecentBulkUploads.mockReturnValue({ data: { items: [] }, isLoading: false, refetch });
  });

  afterEach(() => vi.clearAllMocks());

  it('renders the drag prompt, participant-type chip, and hint when no file is picked', () => {
    renderUpload();
    expect(screen.getByText('Drag your CSV here or')).toBeInTheDocument();
    expect(screen.getByLabelText('Participant type: Seekers')).toBeInTheDocument();
    expect(screen.getByText(/uploaded as seekers/)).toBeInTheDocument();
  });

  it('shows the fallback attestation label when no attestation content is supplied', () => {
    renderUpload();
    expect(
      screen.getByText(
        'I confirm I have permission from the individuals in this file to submit their details.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the server-supplied attestation content when supplied', () => {
    renderUpload({
      attestation: { version: 1, title: 'Attest', content: 'Custom attestation copy.' },
    });
    expect(screen.getByText('Custom attestation copy.')).toBeInTheDocument();
  });

  it('rejects a non-csv file with an inline error and does not show a file chip', () => {
    renderUpload();
    const input = document.getElementById('csv-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'roster.txt')] } });
    expect(screen.getByText('Only .csv files are accepted.')).toBeInTheDocument();
    expect(screen.queryByText('roster.txt')).not.toBeInTheDocument();
  });

  it('tells an operator who uploads the Excel template to export it as CSV', () => {
    // Handing out an .xlsx makes this the obvious mistake, and "Only .csv files
    // are accepted" does not say how to fix it.
    renderUpload();
    const input = document.getElementById('csv-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'seeker-template.xlsx')] } });
    expect(screen.getByText(/Save As.*CSV/i)).toBeInTheDocument();
    expect(screen.queryByText('Only .csv files are accepted.')).not.toBeInTheDocument();
  });

  it('accepts a .csv file via the file input and shows a removable chip', async () => {
    const user = userEvent.setup();
    renderUpload();
    const input = document.getElementById('csv-file-input') as HTMLInputElement;
    const file = makeCsv();
    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByText('roster.csv')).toBeInTheDocument();
    expect(screen.getByText(/KB$/)).toBeInTheDocument();

    await user.click(screen.getByLabelText('Remove file'));
    expect(screen.queryByText('roster.csv')).not.toBeInTheDocument();
    expect(screen.getByText('Drag your CSV here or')).toBeInTheDocument();
  });

  it('accepts a .csv file dropped onto the dropzone', () => {
    renderUpload();
    const dropzone = screen.getByText('Drag your CSV here or').closest('.dropzone') as HTMLElement;
    fireEvent.drop(dropzone, { dataTransfer: { files: [makeCsv('dropped.csv')] } });
    expect(screen.getByText('dropped.csv')).toBeInTheDocument();
  });

  it('clears a prior file-type error once a valid csv is subsequently picked', () => {
    renderUpload();
    const input = document.getElementById('csv-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'bad.txt')] } });
    expect(screen.getByText('Only .csv files are accepted.')).toBeInTheDocument();
    fireEvent.change(input, { target: { files: [makeCsv()] } });
    expect(screen.queryByText('Only .csv files are accepted.')).not.toBeInTheDocument();
  });

  it('keeps Upload disabled until a file is picked and the attestation is checked', async () => {
    const user = userEvent.setup();
    renderUpload();
    const uploadButton = screen.getByRole('button', { name: 'Upload' });
    expect(uploadButton).toBeDisabled();

    const input = document.getElementById('csv-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeCsv()] } });
    expect(uploadButton).toBeDisabled(); // file picked, not yet attested

    await user.click(screen.getByRole('checkbox'));
    expect(uploadButton).toBeEnabled();
  });

  it('disables Upload while a mutation is pending, and shows the "Uploading…" label', () => {
    useBulkUpload.mockReturnValue({ mutateAsync, isPending: true });
    renderUpload();
    expect(screen.getByRole('button', { name: 'Uploading…' })).toBeDisabled();
  });

  async function pickAndAttest(user: ReturnType<typeof userEvent.setup>) {
    const input = document.getElementById('csv-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeCsv()] } });
    await user.click(screen.getByRole('checkbox'));
  }

  it('uploads successfully: clears the file, shows a success toast, refetches, and navigates back after a delay', async () => {
    mutateAsync.mockResolvedValue({ duplicate: false });
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const user = userEvent.setup();
    renderUpload();
    await pickAndAttest(user);

    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(mutateAsync).toHaveBeenCalledWith({
      file: expect.any(File),
      participantType: 'seeker',
      attestation: true,
    });
    await waitFor(() => expect(screen.queryByText('roster.csv')).not.toBeInTheDocument());
    expect(
      await screen.findByText(
        'Accounts will be live once the user logs in on the platform or via the call.',
      ),
    ).toBeInTheDocument();
    expect(refetch).toHaveBeenCalled();

    const navCall = setTimeoutSpy.mock.calls.find((c) => c[1] === 2500);
    expect(navCall).toBeDefined();
    (navCall![0] as () => void)();
    expect(pushMock).toHaveBeenCalledWith('/onboarding');
  });

  it('treats a duplicate upload as a notice (not a navigation) with the server-supplied message', async () => {
    mutateAsync.mockResolvedValue({ duplicate: true, message: 'Already uploaded on Monday.' });
    const user = userEvent.setup();
    renderUpload();
    await pickAndAttest(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText('Already uploaded on Monday.')).toBeInTheDocument();
    expect(refetch).toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('falls back to a default duplicate message when the server omits one', async () => {
    mutateAsync.mockResolvedValue({ duplicate: true });
    const user = userEvent.setup();
    renderUpload();
    await pickAndAttest(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(
      await screen.findByText('This CSV was already uploaded earlier — showing the existing run.'),
    ).toBeInTheDocument();
  });

  it('surfaces the mutation error message inline on failure', async () => {
    mutateAsync.mockRejectedValue(new Error('S3 PUT failed (500)'));
    const user = userEvent.setup();
    renderUpload();
    await pickAndAttest(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText('S3 PUT failed (500)')).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('says the file was received, clears it and re-reads the list when /start cannot be confirmed', async () => {
    mutateAsync.mockRejectedValue(new BulkUploadStartUnreadError('up-9'));
    const user = userEvent.setup();
    renderUpload();
    await pickAndAttest(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText(messages.onboarding.csv.start_unconfirmed)).toBeInTheDocument();
    expect(screen.queryByText('roster.csv')).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
    expect(refetch).toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('shows a plain message instead of the raw text for an unreadable reply', async () => {
    mutateAsync.mockRejectedValue(new ResponseShapeError('/api/bulk-uploads', []));
    const user = userEvent.setup();
    renderUpload();
    await pickAndAttest(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText(messages.onboarding.csv.reply_unreadable)).toBeInTheDocument();
    expect(screen.queryByText(/unexpected response shape/)).not.toBeInTheDocument();
  });

  it('redirects to the template-download endpoint scoped to the participant type', async () => {
    const user = userEvent.setup();
    const origLocation = window.location;
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: { ...origLocation, href: '' },
    });

    renderUpload();
    // The workbook is the only template offered: it carries the dropdowns and
    // the required-column marking, and a bare CSV alongside it would just be
    // the version with no guidance. The endpoint still defaults to CSV for API
    // callers.
    await user.click(screen.getByText('Download Excel template'));
    expect(window.location.href).toBe(
      '/api/bulk-uploads/template?participant_type=seeker&format=xlsx',
    );
    expect(screen.queryByText('Download CSV template')).not.toBeInTheDocument();

    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: origLocation,
    });
  });

  it('falls back to the aggregator config default domain when the profile has not loaded', () => {
    useProfileRaw.mockReturnValue({ data: undefined });
    renderUpload();
    expect(screen.getByLabelText('Participant type: Seekers')).toBeInTheDocument();
  });

  it('uploads as the profile type once the profile loads after the first render', async () => {
    mutateAsync.mockResolvedValue({ duplicate: true });
    useProfileRaw.mockReturnValue({ data: undefined });
    const user = userEvent.setup();
    const { rerender } = renderUpload();
    expect(screen.getByText(/uploaded as seekers/)).toBeInTheDocument();

    useProfileRaw.mockReturnValue({ data: { type: 'provider' } });
    rerender(
      <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
        <CSVUpload />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/uploaded as providers/)).toBeInTheDocument();
    expect(screen.getByLabelText('Participant type: Providers')).toBeInTheDocument();

    await pickAndAttest(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect(mutateAsync.mock.calls[0]![0].participantType).toBe('provider');
  });

  it('keeps Upload and the template download disabled until the profile type is known', async () => {
    useProfileRaw.mockReturnValue({ data: undefined });
    const user = userEvent.setup();
    renderUpload();
    await pickAndAttest(user);
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Download Excel template/ })).toBeDisabled();
  });

  async function uploadWithFakeTimers() {
    const input = document.getElementById('csv-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeCsv()] } });
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    });
  }

  it('shows the success toast for the full delay across re-renders, then returns to the overview', async () => {
    vi.useFakeTimers();
    try {
      mutateAsync.mockResolvedValue({ duplicate: false });
      const { rerender } = renderUpload();
      await uploadWithFakeTimers();
      const toastText = messages.onboarding.csv.success_note;
      expect(screen.getByText(toastText)).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(1000));
      rerender(
        <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
          <CSVUpload />
        </NextIntlClientProvider>,
      );
      act(() => vi.advanceTimersByTime(1499));
      expect(screen.getByText(toastText)).toBeInTheDocument();
      expect(pushMock).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByText(toastText)).not.toBeInTheDocument();
      expect(pushMock).toHaveBeenCalledTimes(1);
      expect(pushMock).toHaveBeenCalledWith('/onboarding');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not return to the overview after the widget unmounts', async () => {
    vi.useFakeTimers();
    try {
      mutateAsync.mockResolvedValue({ duplicate: false });
      const { unmount } = renderUpload();
      await uploadWithFakeTimers();
      unmount();
      act(() => vi.advanceTimersByTime(10_000));
      expect(pushMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the file input when the picked file is removed', async () => {
    const user = userEvent.setup();
    renderUpload();
    const input = document.getElementById('csv-file-input') as HTMLInputElement;
    await user.upload(input, makeCsv());
    expect(input.files).toHaveLength(1);
    await user.click(screen.getByLabelText('Remove file'));
    expect(input.value).toBe('');
  });
});
