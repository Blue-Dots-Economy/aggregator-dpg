/** Badge colours per upload status. */
const STATUS_STYLE: Record<string, { bg: string; tone: string }> = {
  pending: { bg: 'bg-ink-50', tone: 'text-ink-600' },
  uploaded: { bg: 'bg-sky-50', tone: 'text-sky-700' },
  file_validating: { bg: 'bg-amber-50', tone: 'text-amber-700' },
  file_failed: { bg: 'bg-rose-50', tone: 'text-rose-700' },
  row_processing: { bg: 'bg-amber-50', tone: 'text-amber-700' },
  finalising: { bg: 'bg-amber-50', tone: 'text-amber-700' },
  completed: { bg: 'bg-emerald-50', tone: 'text-emerald-700' },
  failed: { bg: 'bg-rose-50', tone: 'text-rose-700' },
};
const DEFAULT_STATUS_STYLE = { bg: 'bg-ink-50', tone: 'text-ink-600' };

/** Coloured pill with an upload's raw status. */
export function UploadStatusBadge({ status }: Readonly<{ status: string }>) {
  const style = STATUS_STYLE[status] ?? DEFAULT_STATUS_STYLE;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-[11.5px] ${style.bg} ${style.tone}`}
    >
      {status}
    </span>
  );
}
