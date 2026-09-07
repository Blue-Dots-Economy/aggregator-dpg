/**
 * The one renderer for externalised email cases.
 *
 * Belongs to `@aggregator-dpg/api`. Every case's HTML body, plain-text body
 * and subject come out of this function, driven by the declarative layout on
 * its registry entry. Before this existed each template module repeated the
 * same four steps — look up copy, substitute tokens, assemble blocks, derive
 * the text part — which is four chances per template for the two parts to
 * drift, and six copies to edit when the shell changes.
 *
 * A template module now supplies only its typed inputs; the layout lives in
 * `email-cases.ts` and the copy lives in the properties layers.
 *
 * @module @aggregator-dpg/api
 */

import {
  callout,
  ctaButton,
  ctaRow,
  getEmailBrand,
  heading,
  note,
  para,
  paraLast,
  paraSmall,
  renderShell,
} from './shared.js';
import { caseTokenTypes, getEmailCase, type BlockSpec } from './email-cases.js';
import { getMessage } from './messages.js';
import { substitute, toPlainText } from './substitute.js';

/** Token values for one render. `undefined` means "not supplied". */
export type CaseValues = Readonly<Record<string, string | undefined>>;

/** The three parts every mailer send needs. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Decides whether a conditional block belongs in this render.
 *
 * `requires` keeps a block out unless every named token has a value;
 * `absent` keeps it out unless every named token has none. Together they
 * express the three conditionals the migrated templates actually have — an
 * optional rejection reason, a named-vs-anonymous greeting, and the
 * invite-link-vs-coming-soon tail — without any of them being code.
 */
function blockApplies(spec: BlockSpec, values: CaseValues): boolean {
  for (const token of spec.requires ?? []) {
    if (values[token] === undefined || values[token] === '') return false;
  }
  for (const token of spec.absent ?? []) {
    if (values[token] !== undefined && values[token] !== '') return false;
  }
  return true;
}

const BLOCK_RENDERERS: Record<string, (html: string) => string> = {
  heading,
  para,
  paraLast,
  paraSmall,
  note,
  callout,
};

/**
 * Picks the first key whose block applies, for a `oneOf` alternation.
 *
 * @param spec - Block spec carrying `oneOf` alternatives.
 * @param values - Token values.
 * @returns The chosen key, or undefined when no alternative applies.
 */
function chooseKey(spec: BlockSpec, values: CaseValues): string | undefined {
  if (!spec.oneOf) return spec.key;
  for (const alt of spec.oneOf) {
    if (blockApplies({ ...spec, ...alt, oneOf: undefined }, values)) return alt.key;
  }
  return undefined;
}

/**
 * Renders one externalised email case.
 *
 * @param caseId - Registry key, e.g. `applicant_approved`.
 * @param values - Token values. Brand tokens are added automatically, and a
 *   token used for a CTA href is passed through unescaped by the button
 *   helper rather than substituted into copy.
 * @returns Subject plus the HTML and plain-text bodies.
 * @throws {Error} If the case is not registered.
 */
export function renderCase(caseId: string, values: CaseValues): RenderedEmail {
  const def = getEmailCase(caseId);
  const brand = getEmailBrand();
  const types = caseTokenTypes(caseId);

  const all: CaseValues = {
    brandShort: brand.short_name,
    brandLong: brand.long_name,
    ...values,
  };

  // Derived tokens are alternations resolved to already-substituted HTML, so
  // they are declared `html` in the registry and inserted raw.
  const derived: Record<string, string> = {};
  for (const [token, alternatives] of Object.entries(def.derivedTokens ?? {})) {
    const key = chooseKey({ block: 'para', key: alternatives[0]!.key, oneOf: alternatives }, all);
    if (key) derived[token] = substitute(getMessage(`${caseId}.${key}`), all, types);
  }
  const withDerived: CaseValues = { ...all, ...derived };

  const copy = (key: string): string =>
    substitute(getMessage(`${caseId}.${key}`), withDerived, types);

  const subject = toPlainText(copy(def.subjectKey ?? 'subject'));

  const htmlBlocks: string[] = [];
  const textBlocks: string[] = [];

  for (const spec of def.layout) {
    if (!blockApplies(spec, withDerived)) continue;
    const key = chooseKey(spec, withDerived);
    if (key === undefined) continue;
    const fragment = copy(key);

    if (spec.block === 'cta') {
      const href = spec.href ? withDerived[spec.href] : undefined;
      if (href === undefined) continue;
      const label = toPlainText(fragment);
      htmlBlocks.push(ctaRow(ctaButton(label, href, spec.tone ?? 'primary')));
      textBlocks.push(`${label}: ${href}`);
      continue;
    }

    const render = BLOCK_RENDERERS[spec.block];
    if (!render) throw new Error(`unknown block kind: ${spec.block}`);
    htmlBlocks.push(render(fragment));
    textBlocks.push(toPlainText(fragment));
  }

  const signOff = def.signOff === false ? '' : `\nSent by ${brand.long_name}.\n`;
  const text = `${textBlocks.join('\n\n')}\n${signOff}`;

  return {
    subject,
    html: renderShell({ preheader: subject, bodyHtml: htmlBlocks.join('\n') }),
    text,
  };
}
