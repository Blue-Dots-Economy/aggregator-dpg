/**
 * Identity-selector sniffer.
 *
 * Given a JSON Schema for a participant profile (seeker, provider,
 * learner, …) returns the field names the aggregator uses as canonical
 * `name`, `phone`, `email`. The heuristic covers the four signalstack
 * networks we know about (blue_dot, purple_dot, yellow_dot, learner-
 * tutor) without manual overrides; operators who add a new schema
 * with unusual field naming can override via `field_overrides` in the
 * aggregator YAML.
 *
 * @module @aggregator-dpg/network-config/sniffer
 */

import type { IdentitySelectors } from './interface.js';

/**
 * Subset of JSON Schema we look at — keeps the sniffer independent of
 * a particular Ajv version. Unknown keys are ignored.
 */
interface SchemaProperty {
  type?: string | string[];
  pattern?: string;
  format?: string;
  title?: string;
  minLength?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
}

interface SchemaShape {
  properties?: Record<string, SchemaProperty>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
}

/**
 * Heuristic — try to derive {@link IdentitySelectors} from a JSON
 * Schema's property definitions. Returns `null` when any of the three
 * required selectors cannot be confidently inferred so the caller
 * raises a clear configuration error instead of silently routing data
 * through a wrong field.
 *
 * Detection rules (in priority order):
 *   - **phone**: schema `pattern` matches a 10-digit or E.164 form;
 *     OR `format: tel`; OR field name contains "phone" or "mobile".
 *   - **email**: schema `format: email`; OR field name contains
 *     "email".
 *   - **name**: field named exactly "name"; OR ends in "_name";
 *     OR contains "name" with a `minLength >= 1` string type
 *     (excluding phone/email matches).
 */
export function sniffIdentitySelectors(schema: unknown): IdentitySelectors | null {
  if (!schema || typeof schema !== 'object') return null;
  const props = (schema as SchemaShape).properties;
  if (!props || typeof props !== 'object') return null;

  const phone = pickFirstMatch(props, isPhoneField);
  const email = pickFirstMatch(props, isEmailField);
  if (!phone || !email) return null;

  const name = pickFirstMatch(props, (p, n) => isNameField(p, n) && n !== phone && n !== email);
  if (!name) return null;

  return { name, phone, email };
}

function pickFirstMatch(
  props: Record<string, SchemaProperty>,
  predicate: (prop: SchemaProperty, name: string) => boolean,
): string | null {
  for (const [name, prop] of Object.entries(props)) {
    if (predicate(prop, name)) return name;
  }
  return null;
}

const PHONE_PATTERNS = [/^\^\[0-9\]\{10\}\$$/, /^\\?\+/, /e\.164/i];

function isPhoneField(prop: SchemaProperty, name: string): boolean {
  if (prop.format === 'tel') return true;
  if (typeof prop.pattern === 'string') {
    for (const p of PHONE_PATTERNS) if (p.test(prop.pattern)) return true;
  }
  return /phone|mobile/i.test(name);
}

function isEmailField(prop: SchemaProperty, name: string): boolean {
  if (prop.format === 'email') return true;
  return /email/i.test(name);
}

function isNameField(prop: SchemaProperty, name: string): boolean {
  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  if (type !== 'string' && type !== undefined) return false;
  if (name === 'name') return true;
  // snake_case: `beneficiary_name`, `contact_name`, `name_of_role`.
  if (/(^|_)name($|_)/i.test(name)) return true;
  // camelCase: `jobProviderName`, `firstName`, `nameOfRole`.
  if (/(^name|Name$|^name[A-Z])/i.test(name)) return true;
  return false;
}
