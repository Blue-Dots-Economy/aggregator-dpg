/**
 * Registry of externalised email cases.
 *
 * Belongs to `@aggregator-dpg/api`. Each entry describes one email: the
 * `{{token}}` types its copy may use and the ordered layout of its body blocks.
 * Only `render-case.ts` reads this. To add an email, add an entry here and its
 * keys in the properties layers.
 *
 * Block conditions:
 *
 *   - `requires` — include only when every named token has a value
 *   - `oneOf`    — first alternative whose conditions hold
 *
 * `requiredMessageKeys()` derives the full key list from these layouts. A key
 * missing from the bundled defaults fails the boot check.
 *
 * Only participant-facing mail lives here. `admin-review` and
 * `support-request` are internal mail and stay hardcoded.
 *
 * @module @aggregator-dpg/api
 */

import type { TokenTypes } from './substitute.js';

/** Tokens every case may use; supplied from the resolved brand at render time. */
export const BRAND_TOKENS: TokenTypes = {
  brandShort: 'text',
  brandLong: 'text',
};

/** Block kinds `render-case.ts` knows how to render. */
export type BlockKind = 'heading' | 'para' | 'paraLast' | 'note' | 'cta';

/** One alternative of a `oneOf` block. */
export interface BlockAlternative {
  key: string;
  requires?: readonly string[];
}

/** One block of an email body. */
export interface BlockSpec {
  block: BlockKind;
  /** Copy key, relative to the case prefix. Ignored when `oneOf` is set. */
  key: string;
  /** Include only when every named token has a value. */
  requires?: readonly string[];
  /** Alternatives; the first whose conditions hold is used. */
  oneOf?: readonly BlockAlternative[] | undefined;
  /** For `cta` blocks: the token holding the href. */
  href?: string;
  /** For `cta` blocks: button tone. */
  tone?: 'primary' | 'danger';
}

/** One externalised email case. */
export interface EmailCaseDef {
  /** Declared token types, excluding the brand tokens every case gets. */
  tokens: TokenTypes;
  /** Ordered body blocks. */
  layout: readonly BlockSpec[];
  /** Copy key for the subject. Defaults to `subject`. */
  subjectKey?: string;
  /** Tokens resolved from a copy-key alternation before rendering, for mid-sentence phrases. */
  derivedTokens?: Readonly<Record<string, readonly BlockAlternative[]>>;
}

/** The coordinator and organisation invites share one layout; only their copy differs. */
const INVITE_CASE: EmailCaseDef = {
  tokens: {
    orgName: 'text',
    inviterEmail: 'text',
    recipientName: 'text',
    expiresOn: 'text',
    inviteUrl: 'text',
    // Resolved from the greeting alternation below, so already escaped.
    greeting: 'html',
  },
  derivedTokens: {
    greeting: [{ key: 'greeting', requires: ['recipientName'] }, { key: 'greeting_anonymous' }],
  },
  layout: [
    { block: 'heading', key: 'heading' },
    { block: 'para', key: 'intro' },
    { block: 'para', key: 'role' },
    { block: 'cta', key: 'cta', href: 'inviteUrl' },
    { block: 'para', key: 'expiry' },
    { block: 'paraLast', key: 'next' },
    { block: 'note', key: 'footnote' },
  ],
};

export const EMAIL_CASES: Readonly<Record<string, EmailCaseDef>> = {
  coordinator_invite: INVITE_CASE,

  org_invite: INVITE_CASE,

  coordinator_joined: {
    tokens: { joinerName: 'text', joinerEmail: 'text', orgName: 'text', consoleUrl: 'text' },
    layout: [
      { block: 'heading', key: 'heading' },
      { block: 'paraLast', key: 'intro' },
      { block: 'cta', key: 'cta', href: 'consoleUrl' },
    ],
  },

  org_joined: {
    tokens: { orgName: 'text', ownerEmail: 'text', parentName: 'text', consoleUrl: 'text' },
    layout: [
      { block: 'heading', key: 'heading' },
      { block: 'paraLast', key: 'intro' },
      { block: 'cta', key: 'cta', href: 'consoleUrl' },
    ],
  },

  invite_existing_account: {
    tokens: { orgName: 'text', signInUrl: 'text' },
    layout: [
      { block: 'heading', key: 'heading' },
      { block: 'para', key: 'intro' },
      { block: 'cta', key: 'cta', href: 'signInUrl' },
      { block: 'paraLast', key: 'note' },
      { block: 'note', key: 'footnote' },
    ],
  },

  org_admin_action: {
    tokens: { orgName: 'text', action: 'text', consoleUrl: 'text' },
    layout: [
      { block: 'heading', key: 'heading' },
      { block: 'para', key: 'intro' },
      { block: 'cta', key: 'cta', href: 'consoleUrl' },
      { block: 'note', key: 'footnote' },
    ],
  },

  org_known_as: {
    tokens: { orgName: 'text', parentName: 'text', consoleUrl: 'text' },
    layout: [
      { block: 'heading', key: 'heading' },
      { block: 'para', key: 'intro' },
      { block: 'cta', key: 'cta', href: 'consoleUrl' },
      { block: 'note', key: 'footnote' },
    ],
  },
} as const;

/** Case ids, for iteration at boot. */
export const EMAIL_CASE_IDS: readonly string[] = Object.keys(EMAIL_CASES);

/**
 * Looks up a case definition.
 *
 * @param caseId - Case prefix, e.g. `coordinator_invite`.
 * @returns The case definition.
 * @throws {Error} If the case is not registered.
 */
export function getEmailCase(caseId: string): EmailCaseDef {
  const def = EMAIL_CASES[caseId];
  if (!def) throw new Error(`unknown email case: ${caseId}`);
  return def;
}

/**
 * Every copy key a case can ask for, derived from its layout.
 *
 * @param caseId - Case prefix.
 * @returns Keys relative to the case prefix, deduplicated.
 */
export function caseKeys(caseId: string): string[] {
  const def = getEmailCase(caseId);
  const keys = new Set<string>([def.subjectKey ?? 'subject']);
  for (const spec of def.layout) {
    if (spec.oneOf) for (const alt of spec.oneOf) keys.add(alt.key);
    else keys.add(spec.key);
  }
  for (const alternatives of Object.values(def.derivedTokens ?? {})) {
    for (const alt of alternatives) keys.add(alt.key);
  }
  return [...keys];
}

/**
 * Fully-qualified key list every copy layer is validated against.
 *
 * @returns Every `<case>.<key>` the code can ask for.
 */
export function requiredMessageKeys(): string[] {
  return EMAIL_CASE_IDS.flatMap((id) => caseKeys(id).map((k) => `${id}.${k}`));
}

/**
 * Declared token types for a case, including the shared brand tokens.
 *
 * @param caseId - Case prefix, e.g. `coordinator_invite`.
 * @returns Token types for substitution.
 * @throws {Error} If the case is not registered.
 */
export function caseTokenTypes(caseId: string): TokenTypes {
  return { ...BRAND_TOKENS, ...getEmailCase(caseId).tokens };
}
