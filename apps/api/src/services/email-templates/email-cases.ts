/**
 * Registry of externalised email cases.
 *
 * Belongs to `@aggregator-dpg/api`. Each entry fully describes one email: the
 * `{{token}}` types its copy may use, and the ordered layout of copy blocks
 * that makes up its body. `render-case.ts` is the only thing that reads this,
 * so adding an email means adding an entry here plus its keys in the
 * properties layers — no new module, no repeated assembly code.
 *
 * The layout carries the three conditionals the migrated templates actually
 * have, declaratively rather than as code:
 *
 *   - `requires` — include only when every named token has a value
 *   - `absent`   — include only when every named token has none
 *   - `oneOf`    — first alternative whose conditions hold
 *
 * `requiredMessageKeys()` derives the full key list from these layouts, so a
 * key referenced by a layout but missing from the bundled defaults fails the
 * boot check rather than rendering as its own name.
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

/** Block kinds `render-case.ts` knows how to render. */
export type BlockKind = 'heading' | 'para' | 'paraLast' | 'paraSmall' | 'note' | 'callout' | 'cta';

/** One alternative of a `oneOf` block. */
export interface BlockAlternative {
  key: string;
  requires?: readonly string[];
  absent?: readonly string[];
}

/** One block of an email body. */
export interface BlockSpec {
  block: BlockKind;
  /** Copy key, relative to the case prefix. Ignored when `oneOf` is set. */
  key: string;
  /** Include only when every named token has a value. */
  requires?: readonly string[];
  /** Include only when every named token has NO value. */
  absent?: readonly string[];
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
  /**
   * Tokens resolved from a copy-key alternation before the body renders, for
   * a phrase embedded mid-sentence rather than standing as its own block.
   */
  derivedTokens?: Readonly<Record<string, readonly BlockAlternative[]>>;
  /** Append "Sent by <brand>." to the text part. Defaults to true. */
  signOff?: boolean;
}

export const EMAIL_CASES: Readonly<Record<string, EmailCaseDef>> = {
  applicant_approved: {
    tokens: { contactName: 'text', association: 'text', identifier: 'text', signInUrl: 'text' },
    layout: [
      { block: 'heading', key: 'heading' },
      { block: 'para', key: 'intro' },
      { block: 'paraLast', key: 'identifier' },
      { block: 'cta', key: 'cta', href: 'signInUrl' },
      { block: 'note', key: 'footnote' },
    ],
  },

  applicant_rejected: {
    tokens: {
      contactName: 'text',
      association: 'text',
      entityLabel: 'text',
      reason: 'text',
    },
    // No sign-off: a decline ends on the appeal line.
    signOff: false,
    layout: [
      {
        block: 'heading',
        key: 'greeting',
        oneOf: [{ key: 'greeting', requires: ['contactName'] }, { key: 'greeting_anonymous' }],
      },
      { block: 'para', key: 'intro' },
      { block: 'para', key: 'outcome' },
      { block: 'callout', key: 'reason', requires: ['reason'] },
      { block: 'paraSmall', key: 'appeal' },
    ],
  },

  coordinator_invite: {
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
  },

  org_owner_approved: {
    tokens: { orgName: 'text', ownerEmail: 'text', inviteUrl: 'text' },
    layout: [
      { block: 'heading', key: 'heading' },
      { block: 'para', key: 'intro' },
      // With the grant link: lead, button, then the standing note.
      { block: 'para', key: 'invite_lead', requires: ['inviteUrl'] },
      // No `requires` needed: the cta branch already drops a block whose href
      // token is unset. Stated here because the two neighbours below do need it.
      { block: 'cta', key: 'cta', href: 'inviteUrl' },
      { block: 'paraLast', key: 'invite_note', requires: ['inviteUrl'] },
      // Without it: a heads-up that the link follows.
      { block: 'paraLast', key: 'invite_pending', absent: ['inviteUrl'] },
    ],
  },

  owner_grant_refreshed: {
    tokens: { orgName: 'text', inviteUrl: 'text' },
    layout: [
      { block: 'heading', key: 'heading' },
      { block: 'para', key: 'intro' },
      { block: 'cta', key: 'cta', href: 'inviteUrl' },
      { block: 'paraLast', key: 'note' },
      { block: 'note', key: 'footnote' },
    ],
  },

  org_already_registered: {
    tokens: { orgName: 'text', inviteUrl: 'text' },
    layout: [
      { block: 'heading', key: 'heading' },
      { block: 'para', key: 'intro' },
      { block: 'para', key: 'reason' },
      { block: 'cta', key: 'cta', href: 'inviteUrl' },
      { block: 'paraLast', key: 'note' },
      { block: 'note', key: 'footnote' },
    ],
  },
} as const;

/** Case ids, for iteration at boot. */
export const EMAIL_CASE_IDS: readonly string[] = Object.keys(EMAIL_CASES);

/**
 * Looks up a case definition.
 *
 * @param caseId - Case prefix, e.g. `applicant_approved`.
 * @returns The case definition.
 * @throws {Error} If the case is not registered — a programming error, raised
 *   at the call site rather than rendering an empty email.
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
 * @param caseId - Case prefix, e.g. `applicant_approved`.
 * @returns Token types for substitution.
 * @throws {Error} If the case is not registered.
 */
export function caseTokenTypes(caseId: string): TokenTypes {
  return { ...BRAND_TOKENS, ...getEmailCase(caseId).tokens };
}
