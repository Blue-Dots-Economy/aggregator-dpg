/**
 * Adds a message to one field of an RJSF `FormValidation` tree, for
 * `customValidate` functions (web app).
 */

import { isJsonObject } from '@/lib/json-object';

/** A node of RJSF's `FormValidation` tree that accepts errors. */
interface FieldErrors {
  addError(message: string): void;
}

/** Whether a value is a `FormValidation` node with an `addError` function. */
function isFieldErrors(value: unknown): value is FieldErrors {
  return isJsonObject(value) && typeof value['addError'] === 'function';
}

/**
 * Adds `message` to the field at `path` in an RJSF error tree.
 *
 * @param errors - The `errors` argument of `customValidate`.
 * @param path - Property names from the form root to the field.
 * @param message - The error text.
 * @returns Whether the field was found and the message added.
 */
export function addFieldError(errors: unknown, path: readonly string[], message: string): boolean {
  let node: unknown = errors;
  for (const key of path) node = isJsonObject(node) ? node[key] : undefined;
  if (!isFieldErrors(node)) return false;
  node.addError(message);
  return true;
}
