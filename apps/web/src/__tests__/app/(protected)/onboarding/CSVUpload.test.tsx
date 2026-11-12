/**
 * Tests for `CSVUpload` (the upload widget) and `RecentUploadsBody` (the
 * "recent uploads" table), the two exports of
 * `app/(protected)/onboarding/_components/CSVUpload.tsx`.
 *
 * This is the largest / highest-priority file in the onboarding scope, so
 * coverage here is deliberately thorough: file-type validation, drag+drop,
 * the attestation gate, the full upload lifecycle (success / duplicate /
 * failure), the template-download redirect, and every branch of the
 * recent-uploads table (loading/error/empty, status badges, the errors-CSV
 * download action and its failure path).
 *
 * `setTimeout`-driven UI (the success toast and the post-upload navigation
 * delay) is exercised by spying on `global.setTimeout` and invoking the
 * captured callback directly — this avoids fighting fake timers against
 * Testing Library's async `findBy*`/`waitFor` polling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { BulkUploadStatus } from '@/services/onboarding.service';
import {
  BulkUploadEmptyError,
  BulkUploadStartUnreadError,
  BulkUploadTooLargeError,
} from '@/services/onboarding.service';
import type * as OnboardingServiceModule from '@/services/onboarding.service';
import { ResponseShapeError } from '@/lib/response-shape-error';
import { HttpError } from '@/services/http';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => '/onboarding/upload',
  useSearchParams: () => new URLSearchParams(),
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

import { CSVUpload, RecentUploadsBody } from '@/app/(protected)/onboarding/_components/CSVUpload';

/** Opens the Radix domain dropdown and picks an option; jsdom needs the pointer stubs. */
async function pickDomain(name: RegExp): Promise<void> {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  fireEvent.click(screen.getByRole('combobox', { name: 'Profile Type' }));
  fireEvent.click(await screen.findByRole('option', { name }));
}

function renderUpload(props: Parameters<typeof CSVUpload>[0] = {}) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={{
        common: messages.common,
        onboarding: messages.onboarding,
        access: messages.access,
      }}
    >
      <CSVUpload {...props} />
    </NextIntlClientProvider>,
  );
}

function renderRecent() {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={{ onboarding: messages.onboarding, access: messages.access }}
    >
      <RecentUploadsBody />
    </NextIntlClientProvider>,
  );
}

function makeCsv(name = 'roster.csv', content = 'name,phone\nA,123') {
  return new File([content], name, { type: 'text/csv' });
}

function baseUpload(overrides: Partial<BulkUploadStatus> = {}): BulkUploadStatus {
  return {
    upload_id: 'up-1',
    status: 'completed',
    status_reason: null,
    participant_type: 'seeker',
    total_rows: 10,
    passed: 8,
    failed: 2,
    skipped: 0,
    errors_csv_s3_key: null,
    schema_id: 'profile',
    schema_version: '1.0',
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('<CSVUpload />', () => {
  const mutateAsync = vi.fn();
  const refetch = vi.fn();

  beforeEach(() => {
    pushMock.mockClear();
    mutateAsync.mockReset();
    refetch.mockClear();
    useAggregatorConfig.mockReturnValue({ data: { ...cfg, bulk_upload_max_bytes: 10485760 } });
    useProfileRaw.mockReturnValue({ data: { type: 'seeker', serves: ['seeker'] } });
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
      maxBytes: 10485760,
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

  it('shows a plain message, not the error text, when the upload fails', async () => {
    mutateAsync.mockRejectedValue(new Error('File upload failed (500): <Error>…</Error>'));
    const user = userEvent.setup();
    renderUpload();
    await pickAndAttest(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText(messages.onboarding.csv.upload_failed)).toBeInTheDocument();
    expect(screen.queryByText(/File upload failed/)).not.toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('explains a refused profile type when the upload answers DOMAIN_NOT_SERVED', async () => {
    mutateAsync.mockRejectedValue(new HttpError(403, 'DOMAIN_NOT_SERVED'));
    const user = userEvent.setup();
    renderUpload();
    await pickAndAttest(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText(messages.access.domain_not_served)).toBeInTheDocument();
  });

  it('says the upload limit was reached when the api answers RATE_LIMITED', async () => {
    mutateAsync.mockRejectedValue(new HttpError(429, 'RATE_LIMITED'));
    const user = userEvent.setup();
    renderUpload();
    await pickAndAttest(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText(messages.onboarding.csv.rate_limited)).toBeInTheDocument();
    expect(screen.queryByText(messages.onboarding.csv.upload_failed)).not.toBeInTheDocument();
  });

  it('says the file is empty', async () => {
    mutateAsync.mockRejectedValue(new BulkUploadEmptyError());
    const user = userEvent.setup();
    renderUpload();
    await pickAndAttest(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText(messages.onboarding.csv.empty)).toBeInTheDocument();
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

  it('shows the size limit in MB and keeps the picked file when the file is too large', async () => {
    mutateAsync.mockRejectedValue(new BulkUploadTooLargeError(10485760));
    const user = userEvent.setup();
    renderUpload();
    await pickAndAttest(user);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(
      await screen.findByText('This file is larger than 10 MB. Upload a smaller file.'),
    ).toBeInTheDocument();
    expect(screen.getByText('roster.csv')).toBeInTheDocument();
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

  it('names no participant type and offers no template until the profile has loaded', () => {
    useProfileRaw.mockReturnValue({ data: undefined });
    renderUpload();
    expect(screen.queryByText('Seekers')).not.toBeInTheDocument();
    expect(screen.getByText('Download Excel template').closest('button')).toBeDisabled();
  });

  it('lets a multi-domain coordinator pick the participant type for the template', async () => {
    window.localStorage.clear();
    useProfileRaw.mockReturnValue({ data: { type: 'seeker', serves: ['seeker', 'provider'] } });
    const user = userEvent.setup();
    const origLocation = window.location;
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: { ...origLocation, href: '' },
    });

    renderUpload();
    const select = screen.getByRole('combobox', { name: 'Profile Type' });
    expect(select).toHaveTextContent(/Seeker/);
    await pickDomain(/Provider/);
    await user.click(screen.getByText('Download Excel template'));
    expect(window.location.href).toBe(
      '/api/bulk-uploads/template?participant_type=provider&format=xlsx',
    );

    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: origLocation,
    });
  });
});

describe('<RecentUploadsBody />', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows a loading-safe empty table when there are no uploads and the query is not loading', () => {
    useRecentBulkUploads.mockReturnValue({ data: { items: [] }, isLoading: false, error: null });
    renderRecent();
    expect(screen.getByText('No uploads yet.')).toBeInTheDocument();
    expect(screen.getByText('0 shown')).toBeInTheDocument();
  });

  it('shows an error row when the query fails', () => {
    useRecentBulkUploads.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('upstream unavailable'),
    });
    renderRecent();
    expect(screen.getByText(messages.onboarding.csv.recent.load_failed)).toBeInTheDocument();
    expect(screen.queryByText('upstream unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('No uploads yet.')).not.toBeInTheDocument();
  });

  it('shows a plain message instead of the raw text when the list reply is unreadable', () => {
    useRecentBulkUploads.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new ResponseShapeError('/api/bulk-uploads/list', []),
    });
    renderRecent();
    expect(screen.getByText(messages.onboarding.csv.reply_unreadable)).toBeInTheDocument();
    expect(screen.queryByText(/unexpected response shape/)).not.toBeInTheDocument();
  });

  it('does not show the empty-state row while the query is still loading', () => {
    useRecentBulkUploads.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderRecent();
    expect(screen.queryByText('No uploads yet.')).not.toBeInTheDocument();
  });

  it('renders a row per upload with status, counts, and a relative + absolute timestamp', () => {
    const hoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    useRecentBulkUploads.mockReturnValue({
      data: { items: [baseUpload({ upload_id: 'u1', created_at: hoursAgo })] },
      isLoading: false,
      error: null,
    });
    renderRecent();
    expect(screen.getByText('1 shown')).toBeInTheDocument();
    expect(screen.getByText('2h ago')).toBeInTheDocument();
    expect(screen.getByText('seeker')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('badges a "provider" row distinctly from "seeker", and formats a days-ago timestamp', () => {
    const daysAgo = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    useRecentBulkUploads.mockReturnValue({
      data: { items: [baseUpload({ participant_type: 'provider', created_at: daysAgo })] },
      isLoading: false,
      error: null,
    });
    renderRecent();
    expect(screen.getByText('provider')).toBeInTheDocument();
    expect(screen.getByText('2d ago')).toBeInTheDocument();
  });

  it('shows "All rows passed" for a completed upload with zero failures', () => {
    useRecentBulkUploads.mockReturnValue({
      data: { items: [baseUpload({ failed: 0, errors_csv_s3_key: null })] },
      isLoading: false,
      error: null,
    });
    renderRecent();
    expect(screen.getByText('All rows passed')).toBeInTheDocument();
  });

  it('shows an em dash when a non-completed upload has no status_reason', () => {
    useRecentBulkUploads.mockReturnValue({
      data: { items: [baseUpload({ status: 'row_processing', status_reason: null, failed: 0 })] },
      isLoading: false,
      error: null,
    });
    renderRecent();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the status_reason for a failed upload with no errors CSV', () => {
    useRecentBulkUploads.mockReturnValue({
      data: {
        items: [
          baseUpload({
            status: 'file_failed',
            status_reason: 'invalid header row',
            errors_csv_s3_key: null,
            failed: 0,
          }),
        ],
      },
      isLoading: false,
      error: null,
    });
    renderRecent();
    expect(screen.getByText(/invalid header row/)).toBeInTheDocument();
  });

  it('downloads the errors CSV and opens it in a new tab when clicked', async () => {
    errorsCsvUrl.mockResolvedValue({ url: 'https://example.com/errors.csv' });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const user = userEvent.setup();
    useRecentBulkUploads.mockReturnValue({
      data: {
        items: [baseUpload({ status: 'completed', failed: 3, errors_csv_s3_key: 'k1' })],
      },
      isLoading: false,
      error: null,
    });
    renderRecent();

    await user.click(screen.getByText('errors.csv'));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        'https://example.com/errors.csv',
        '_blank',
        'noopener,noreferrer',
      ),
    );
    openSpy.mockRestore();
  });

  it('hides the errors CSV from a caller without profiles.view_pii', () => {
    canMock.mockImplementation((c: string) => c !== 'profiles.view_pii');
    useRecentBulkUploads.mockReturnValue({
      data: {
        items: [baseUpload({ status: 'completed', failed: 3, errors_csv_s3_key: 'k1' })],
      },
      isLoading: false,
      error: null,
    });
    renderRecent();
    expect(screen.queryByText('errors.csv')).not.toBeInTheDocument();
    expect(screen.queryByText(/all rows passed/i)).not.toBeInTheDocument();
    canMock.mockImplementation(() => true);
  });

  it('logs a warning and resets the downloading state when the errors-CSV fetch fails', async () => {
    errorsCsvUrl.mockRejectedValue(new Error('sign failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const user = userEvent.setup();
    useRecentBulkUploads.mockReturnValue({
      data: {
        items: [baseUpload({ status: 'completed', failed: 3, errors_csv_s3_key: 'k1' })],
      },
      isLoading: false,
      error: null,
    });
    renderRecent();

    await user.click(screen.getByText('errors.csv'));
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(screen.getByText('errors.csv')).toBeInTheDocument(); // downloading flag reset, button back to normal label
    expect(
      await screen.findByText(messages.onboarding.csv.recent.errors_download_failed),
    ).toBeInTheDocument();
    warnSpy.mockRestore();
  });

  it('says the errors report is no longer available when the api answers 404', async () => {
    errorsCsvUrl.mockRejectedValue(new HttpError(404, 'NOT_FOUND'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const user = userEvent.setup();
    useRecentBulkUploads.mockReturnValue({
      data: {
        items: [baseUpload({ status: 'completed', failed: 3, errors_csv_s3_key: 'k1' })],
      },
      isLoading: false,
      error: null,
    });
    renderRecent();

    await user.click(screen.getByText('errors.csv'));
    expect(
      await screen.findByText(messages.onboarding.csv.recent.errors_unavailable),
    ).toBeInTheDocument();
    warnSpy.mockRestore();
  });

  it('renders an unmapped status raw via the badge fallback style', () => {
    useRecentBulkUploads.mockReturnValue({
      data: { items: [baseUpload({ status: 'some_new_status', failed: 0 })] },
      isLoading: false,
      error: null,
    });
    renderRecent();
    expect(screen.getByText('some_new_status')).toBeInTheDocument();
  });
});
