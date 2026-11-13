/**
 * Screen-reader error wiring shared by the RJSF widgets in `@aggregator-dpg/web`.
 *
 * @module apps/web/src/components/forms/error-aria
 */

import { errorId } from '@rjsf/utils';

/**
 * Marks a widget invalid and links it to its error list for screen readers.
 *
 * @param id - The widget id RJSF passes in.
 * @param rawErrors - The field's current errors.
 * @returns `aria-invalid` + `aria-describedby`, or nothing when the field is valid.
 */
export function errorAria(
  id: string,
  rawErrors: string[] | undefined,
): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
  return rawErrors?.length ? { 'aria-invalid': true, 'aria-describedby': errorId(id) } : {};
}
