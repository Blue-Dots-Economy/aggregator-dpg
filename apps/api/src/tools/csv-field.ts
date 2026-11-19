/**
 * CSV cell writing for the operator command reports in `@aggregator-dpg/api`
 * (org loader, QR links).
 */

/**
 * Neutralises spreadsheet formula injection: a cell starting with `=`, `+`,
 * `-`, `@`, TAB or CR gets a leading single quote. Same rule as `profile-csv`.
 */
function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * Renders one CSV field: formula-neutralised, then RFC 4180 quoted when needed.
 *
 * @param value - The cell text.
 * @returns The text to place between delimiters.
 */
export function csvField(value: string): string {
  const safe = neutraliseFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
