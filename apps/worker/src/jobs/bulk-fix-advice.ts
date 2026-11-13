/**
 * "What to do" advice for errors.csv in the worker app: one plain sentence per
 * failed row telling the coordinator how to fix it, worked out from the same
 * column, rule or Signals code that produced the row's error reasons.
 */

/** errors.csv column that carries the advice; written after `error_reason`. */
export const FIX_ADVICE_COLUMN = 'what_to_do';

/** Name words that mark a phone column; "number"/"no" may follow them. */
const PHONE_WORDS = new Set(['phone', 'mobile']);
const NUMBER_WORDS = new Set(['number', 'no', 'num']);

/** Readable names for JSON Schema types in "It should be …". */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  string: 'text',
  integer: 'whole number',
  number: 'number',
  boolean: 'yes/no value',
  array: 'list of values',
  object: 'group of values',
};

/** Ajv's issue shape, as much of it as the advice reads. */
export interface AdviceIssue {
  keyword?: string;
  params?: Record<string, unknown>;
}

/**
 * True when a column name ends in a phone word (`phone`, `contact_phone`,
 * `mobileNumber`); `mobile_app_url` or `has_smartphone` do not count.
 */
export function isPhoneColumn(name: string): boolean {
  const words = name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const last = words.at(-1) ?? '';
  return PHONE_WORDS.has(last) || (NUMBER_WORDS.has(last) && PHONE_WORDS.has(words.at(-2) ?? ''));
}

/** True when the schema stores `column` as a list (several values in one cell). */
function isListColumn(schema: unknown, column: string): boolean {
  const props = (schema as { properties?: Record<string, { type?: unknown }> } | undefined)
    ?.properties;
  return props !== undefined && Object.hasOwn(props, column) && props[column]?.type === 'array';
}

function typeName(type: unknown): string {
  const first = Array.isArray(type) ? type.find((t) => t !== 'null') : type;
  return typeof first === 'string' && Object.hasOwn(TYPE_NAMES, first)
    ? (TYPE_NAMES[first] ?? 'valid value')
    : 'valid value';
}

const PHONE_ADVICE = (column: string): string =>
  `Check the format of the phone number in the "${column}" column. It should be a 10-digit mobile number, or + and the country code followed by the number.`;

/**
 * Advice for one schema rule a row broke.
 *
 * @param issue - The Ajv issue.
 * @param column - Top-level column the issue names (from `describeSchemaIssue`).
 * @param schema - The participant schema the row was checked against.
 * @param delimiter - Separator for several values in one cell (network config).
 */
export function adviceForSchemaIssue(
  issue: AdviceIssue,
  column: string,
  schema: unknown,
  delimiter: string,
): string {
  const limit = issue.params?.['limit'];
  const limitText = typeof limit === 'number' || typeof limit === 'string' ? String(limit) : '';
  if (!column) return 'Check this row against the columns in the downloadable template.';
  const fill = `Fill in the "${column}" column. It cannot be left blank for this row.`;
  switch (issue.keyword) {
    case 'required':
      return fill;
    case 'additionalProperties':
    case 'unevaluatedProperties':
      return `Remove the "${column}" column; it is not part of the template.`;
    case 'enum':
      return isListColumn(schema, column)
        ? `Check the values in the "${column}" column. Use only the values in the "Allowed values" sheet of the downloadable template, and separate more than one value with ${delimiter} and no spaces.`
        : `Check the value in the "${column}" column. Use only the values in the "Allowed values" sheet of the downloadable template.`;
    case 'pattern':
      return isPhoneColumn(column)
        ? PHONE_ADVICE(column)
        : `Check the format of the value in the "${column}" column.`;
    case 'format':
      return issue.params?.['format'] === 'email'
        ? `Check the email address in the "${column}" column. It should be a full address such as name@domain.`
        : `Check the format of the value in the "${column}" column.`;
    case 'type':
      return `Check the "${column}" column. It should be a ${typeName(issue.params?.['type'])}.`;
    case 'minimum':
    case 'exclusiveMinimum':
      return `Check the "${column}" column. It should be ${issue.keyword === 'minimum' ? 'at least' : 'more than'} ${limitText}.`;
    case 'maximum':
    case 'exclusiveMaximum':
      return `Check the "${column}" column. It should be ${issue.keyword === 'maximum' ? 'at most' : 'less than'} ${limitText}.`;
    case 'minLength':
      // A one-character minimum means "not blank", the way error_reason words it.
      return limit === 1
        ? fill
        : `Check the "${column}" column. It should have at least ${limitText} characters.`;
    case 'maxLength':
      return `Check the "${column}" column. It should have at most ${limitText} characters.`;
    default:
      return `Check the value in the "${column}" column against the downloadable template.`;
  }
}

/** Advice when the row's phone number could not be read. */
export function adviceForPhone(column: string): string {
  return PHONE_ADVICE(column);
}

/**
 * Advice when a row has neither a phone nor an email, so it cannot be added.
 *
 * @param phoneColumn - The phone column, from the network config.
 * @param emailColumn - The email column, when the domain has one.
 */
export function adviceForMissingContact(phoneColumn: string, emailColumn?: string): string {
  return emailColumn
    ? `Fill in the "${phoneColumn}" or "${emailColumn}" column. Each row needs at least one of them.`
    : `Fill in the "${phoneColumn}" column. It cannot be left blank for this row.`;
}

/** Advice when a row has more cells than the template has columns. */
export const SURPLUS_CELLS_ADVICE =
  'Remove the extra cells at the end of this row so it has the same columns as the template.';

const CHECK_IDENTIFIERS =
  'Check the phone number and email on this row for typing mistakes and make sure they belong to this person.';

/** Advice per Signals error code caused by the row's data. */
const SIGNALS_CODE_ADVICE: ReadonlyMap<string, string> = new Map([
  ['MISSING_IDENTIFIER', 'Fill in a phone number or an email address for this person.'],
  [
    'AGE_REQUIRED',
    'Fill in the age or year of birth for this person. People aged 18 or under cannot be added in bulk; remove those rows.',
  ],
  [
    'USER_LEVEL_INCOMPLETE',
    'Fill in the age or year of birth for this person. People aged 18 or under cannot be added in bulk; remove those rows.',
  ],
  ['CONSENT_DECLINED', 'This person did not give consent. Remove the row.'],
  [
    'U18_NOT_ALLOWED',
    'This person is under 18 and cannot be added in bulk. Remove the row; they can register in the app with a guardian.',
  ],
  [
    'LOCATION_OUTSIDE_COUNTRY',
    'Check the location on this row. It must be a place inside the country this portal serves.',
  ],
  [
    'DOMAIN_LOCKED',
    'This person already has an account of another type. Check the phone number and email for typing mistakes; if they are right, remove the row.',
  ],
  ['USER_ALREADY_EXISTS', CHECK_IDENTIFIERS],
  ['IDENTITY_CONFLICT', CHECK_IDENTIFIERS],
]);

/**
 * Advice for a row Signals rejected, or a category default when nothing more
 * specific is known (e.g. a record written by an older worker).
 *
 * @param category - The row's error category.
 * @param upstreamCode - Signals' error code, when it sent one.
 * @param fields - Signals' per-field messages, when it sent them.
 */
export function adviceForRejection(
  category: string,
  upstreamCode: string | undefined,
  fields: Readonly<Record<string, string>> | undefined,
): string[] {
  switch (category) {
    case 'owned_elsewhere':
      return [
        'No action needed. This person is already registered under a different aggregator; do not re-upload this row.',
      ];
    case 'limit_reached':
      return ['This person already has the most profiles allowed. Remove this row.'];
    case 'system_error':
      // The person may already have been added (e.g. after a timeout), and
      // re-uploading always inserts, so a retry could create a duplicate.
      return [
        'This row was not processed because of a problem on our side, not in the row. Do not upload it again yet; it may already have been added. Contact support with the upload time.',
      ];
    case 'duplicate':
      if (!upstreamCode) return [CHECK_IDENTIFIERS];
      break;
    case 'normalisation':
      return [
        'Check the format of the phone number on this row. It should be a 10-digit mobile number, or + and the country code followed by the number.',
      ];
    default:
      break;
  }
  const byCode = upstreamCode ? SIGNALS_CODE_ADVICE.get(upstreamCode) : undefined;
  if (byCode) return [byCode];
  const columns = Object.keys(fields ?? {})
    .map((field) => field.split('.')[0] ?? '')
    .filter(Boolean);
  if (columns.length > 0) {
    return [...new Set(columns)].map((column) =>
      isPhoneColumn(column)
        ? PHONE_ADVICE(column)
        : `Check the value in the "${column}" column against the downloadable template.`,
    );
  }
  return [
    'Check this row against the downloadable template, then fix it in your upload file (not in errors.csv) and upload it again.',
  ];
}

/** One advice cell from several lines, without repeats. */
export function joinAdvice(advice: readonly string[]): string {
  return [...new Set(advice.filter((a) => typeof a === 'string' && a))].join(' ');
}
