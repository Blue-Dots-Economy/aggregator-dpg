/**
 * Field readers for values caught from a mail transport (`@aggregator-dpg/mailer`).
 *
 * The SES and SMTP adapters use them to map a send failure to a mailer error
 * code. Transports throw `Error` subclasses or plain objects, so each field is
 * checked before it is used. Internal to the package; not exported.
 */

/**
 * Reads a string property from a thrown value.
 *
 * @param thrown - The value caught in a `catch` block.
 * @param key - The property name.
 * @returns The property when it is a string, else `undefined`.
 */
export function stringProp(thrown: unknown, key: string): string | undefined {
  if (typeof thrown !== 'object' || thrown === null) return undefined;
  const value: unknown = Reflect.get(thrown, key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads a number property from a thrown value.
 *
 * @param thrown - The value caught in a `catch` block.
 * @param key - The property name.
 * @returns The property when it is a number, else `undefined`.
 */
export function numberProp(thrown: unknown, key: string): number | undefined {
  if (typeof thrown !== 'object' || thrown === null) return undefined;
  const value: unknown = Reflect.get(thrown, key);
  return typeof value === 'number' ? value : undefined;
}
