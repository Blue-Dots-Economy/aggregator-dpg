import type { BulkAttestationContent } from '@/lib/bulk-attestation.server';

/** Props for {@link AttestationCheckbox}. */
export interface AttestationCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Operator attestation copy; `null` shows `fallbackLabel`. */
  attestation: BulkAttestationContent | null;
  fallbackLabel: string;
}

/** Checkbox the operator ticks to confirm permission before uploading. */
export function AttestationCheckbox({
  checked,
  onChange,
  attestation,
  fallbackLabel,
}: Readonly<AttestationCheckboxProps>) {
  return (
    <label className="mt-4 flex items-start gap-2.5 rounded-[10px] border border-(--bd-border) px-3.5 py-3 text-[13px] text-ink-800 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border-(--bd-border) accent-(--bd-primary-600)"
        aria-required
      />
      <span>{attestation ? attestation.content : fallbackLabel}</span>
    </label>
  );
}
