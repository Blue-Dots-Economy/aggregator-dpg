import type { ReactNode } from 'react';

/** Props for {@link LinkField}. */
export interface LinkFieldProps {
  label: string;
  /** Marks the label with a red asterisk. */
  required?: boolean;
  children: ReactNode;
}

/** Labelled wrapper for one input of the link forms. */
export function LinkField({ label, required, children }: Readonly<LinkFieldProps>) {
  return (
    <label className="block">
      <span className="bd-label">
        {label}
        {required && <span className="text-rose-500 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}
