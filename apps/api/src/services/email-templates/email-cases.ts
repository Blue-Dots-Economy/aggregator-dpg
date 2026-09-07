/**
 * Registry of externalised email cases.
 *
 * Belongs to `@aggregator-dpg/api`. Per case: which properties-file keys hold
 * its copy, and the type of every `{{token}}` those keys may use. The registry
 * is what makes the copy files checkable — `assertMessagesComplete()` walks it
 * at boot so a missing key or an undeclared token fails loudly instead of
 * rendering a blank or unescaped email.
 *
 * Only participant-facing mail lives here. `admin-review` and
 * `support-request` stay hardcoded on purpose: they are internal operational
 * mail carrying action links and attachment metadata, with far more structure
 * than copy, and no operator has a reason to reword them.
 *
 * @module @aggregator-dpg/api
 */

import type { TokenTypes } from './substitute.js';

/** Tokens every case may use; supplied from the resolved brand at render time. */
export const BRAND_TOKENS: TokenTypes = {
  brandShort: 'text',
  brandLong: 'text',
};

/** One externalised email case. */
export interface EmailCaseDef {
  /** Keys this case reads. All must exist in the bundled defaults. */
  keys: readonly string[];
  /** Declared token types, excluding the brand tokens every case gets. */
  tokens: TokenTypes;
}

/**
 * Every externalised case, keyed by its properties-file prefix.
 */
export const EMAIL_CASES: Readonly<Record<string, EmailCaseDef>> = {
  applicant_approved: {
    keys: ['subject', 'heading', 'intro', 'identifier', 'cta', 'footnote'],
    tokens: { contactName: 'text', association: 'text', identifier: 'text' },
  },
  applicant_rejected: {
    keys: ['subject', 'greeting', 'greeting_anonymous', 'intro', 'outcome', 'reason', 'appeal'],
    tokens: {
      contactName: 'text',
      association: 'text',
      entityLabel: 'text',
      reason: 'text',
    },
  },
  coordinator_invite: {
    keys: [
      'subject',
      'heading',
      'greeting',
      'greeting_anonymous',
      'intro',
      'role',
      'cta',
      'expiry',
      'next',
      'footnote',
    ],
    tokens: {
      orgName: 'text',
      inviterEmail: 'text',
      recipientName: 'text',
      expiresOn: 'text',
      // Pre-rendered from `greeting` / `greeting_anonymous`, so already escaped.
      greeting: 'html',
    },
  },
  org_owner_approved: {
    keys: ['subject', 'heading', 'intro', 'invite_lead', 'cta', 'invite_note', 'invite_pending'],
    tokens: { orgName: 'text', ownerEmail: 'text' },
  },
  owner_grant_refreshed: {
    keys: ['subject', 'heading', 'intro', 'cta', 'note', 'footnote'],
    tokens: { orgName: 'text' },
  },
  org_already_registered: {
    keys: ['subject', 'heading', 'intro', 'reason', 'cta', 'note', 'footnote'],
    tokens: { orgName: 'text', expiresOn: 'text' },
  },
} as const;

/** Case ids, for iteration at boot. */
export const EMAIL_CASE_IDS: readonly string[] = Object.keys(EMAIL_CASES);

/**
 * Fully-qualified key list every copy layer is validated against.
 *
 * @returns Every `<case>.<key>` the code can ask for.
 */
export function requiredMessageKeys(): string[] {
  return EMAIL_CASE_IDS.flatMap((id) =>
    (EMAIL_CASES[id] as EmailCaseDef).keys.map((k) => `${id}.${k}`),
  );
}

/**
 * Declared token types for a case, including the shared brand tokens.
 *
 * @param caseId - Case prefix, e.g. `applicant_approved`.
 * @returns Token types for substitution.
 * @throws {Error} If the case is not registered — a programming error, raised
 *   at the call site rather than silently escaping everything.
 */
export function caseTokenTypes(caseId: string): TokenTypes {
  const def = EMAIL_CASES[caseId];
  if (!def) throw new Error(`unknown email case: ${caseId}`);
  return { ...BRAND_TOKENS, ...def.tokens };
}
