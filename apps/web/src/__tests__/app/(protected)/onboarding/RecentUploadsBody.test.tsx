/**
 * Tests for `RecentUploadsBody` (the recent uploads table): loading, error and
 * empty states, status badges, and the errors-CSV download and its failure path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { BulkUploadStatus } from '@/services/onboarding.service';
import type * as OnboardingServiceModule from '@/services/onboarding.service';
import { ResponseShapeError } from '@/lib/response-shape-error';

const { useRecentBulkUploads } = vi.hoisted(() => ({ useRecentBulkUploads: vi.fn() }));
vi.mock('@/hooks/useOnboarding', () => ({
  useRecentBulkUploads: (...args: unknown[]) => useRecentBulkUploads(...args),
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

import { RecentUploadsBody } from '@/app/(protected)/onboarding/_components/bulk-upload/RecentUploadsBody';

function renderRecent() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
      <RecentUploadsBody />
    </NextIntlClientProvider>,
  );
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
    expect(screen.getByText('upstream unavailable')).toBeInTheDocument();
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
