/**
 * Lays out the public legal page: splits each consent document into sections
 * and gives every heading an anchor id that is unique across the page. The
 * contents rail, the reading column and the scroll-spy all read this layout,
 * so their ids match.
 *
 * @module apps/web/src/components/legal/legal-layout
 */

import type { ConsentDocContent } from '@/components/consent/consent-types';
import { extractSections, type LegalSection } from './legal-sections';

/** A document shown for each audience. */
export type LegalDoc = 'privacy' | 'terms';

/** One audience's rail group and its Terms/Privacy content. */
export interface LegalGroup {
  /** Stable audience key, e.g. `aggregator` or `org`. */
  audience: string;
  /** Localized group label. */
  label: string;
  /** This audience's versioned Terms + Privacy Policy content. */
  content: ConsentDocContent;
}

/** Render order of the documents within each audience. */
export const DOC_ORDER: readonly LegalDoc[] = ['privacy', 'terms'];

/** One document's versioned content. */
export type DocEntry = ConsentDocContent['terms'];

/** One rendered section: its rail metadata plus the markdown body that follows it. */
export interface RenderableSection extends LegalSection {
  body: string;
}

/** One document as laid out on the page. */
export interface LaidOutDoc {
  entry: DocEntry;
  /** Page-unique anchor id of the document's title heading. */
  headingId: string;
  /** Content before the first section. */
  preamble: string;
  /** Sections with page-unique ids. */
  sections: RenderableSection[];
}

/** One audience as laid out on the page. */
export interface LaidOutGroup {
  audience: string;
  label: string;
  docs: Record<LegalDoc, LaidOutDoc>;
}

/**
 * Builds a value for each document, in `DOC_ORDER`.
 *
 * @param build - Builds the value for one document.
 */
function perDoc<T>(build: (doc: LegalDoc) => T): Record<LegalDoc, T> {
  return { privacy: build('privacy'), terms: build('terms') };
}

/**
 * Builds the anchor id for one audience's document heading.
 *
 * The first group's documents use the bare `privacy` / `terms` ids instead
 * (see `layOutLegalPage`).
 */
function docHeadingId(audience: string, doc: LegalDoc): string {
  return `${audience}-${doc}`;
}

/** Normalizes heading text for a case- and whitespace-insensitive comparison. */
function normalizeHeadingText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when `heading` is the document's own title, repeated as a heading.
 *
 * Consent documents open with a `##` heading that repeats their title. That
 * heading is dropped so it is not shown twice. Other first headings are kept.
 */
function isDocumentTitleHeading(heading: string, title: string): boolean {
  return normalizeHeadingText(heading) === normalizeHeadingText(title);
}

/**
 * Splits a document's markdown into `##`/`###` sections with anchor ids.
 *
 * A leading title heading is dropped and its prose moves to the preamble.
 * With no headings, the whole body is the preamble. Deeper headings stay as
 * normal content.
 *
 * @param markdown - The document body.
 * @param title - The document's title.
 * @returns Any content before the first real section, plus the sections in order.
 */
function splitIntoSections(
  markdown: string,
  title: string,
): { preamble: string; sections: RenderableSection[] } {
  const ids = extractSections(markdown);
  const lines = markdown.split('\n');
  let inFence = false;
  const preambleLines: string[] = [];
  const bodies: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      (current ?? preambleLines).push(line);
      continue;
    }
    // Must match the heading test in `extractSections`, or bodies and
    // sections will not line up.
    if (!inFence && /^#{2,3}\s/.test(line.trim())) {
      current = [];
      bodies.push(current);
      continue;
    }
    (current ?? preambleLines).push(line);
  }

  let sections: RenderableSection[] = ids.map((section, i) => ({
    ...section,
    body: (bodies[i] ?? []).join('\n').trim(),
  }));
  let preamble = preambleLines.join('\n').trim();

  const [leading] = sections;
  if (leading && isDocumentTitleHeading(leading.heading, title)) {
    preamble = [preamble, leading.body].filter(Boolean).join('\n\n');
    sections = sections.slice(1);
  }

  return { preamble, sections };
}

/**
 * Splits every document and assigns anchor ids that are unique across the page.
 *
 * Document heading ids are reserved first, so a section id that collides
 * with one gets a numeric suffix. Ids are assigned in render order.
 *
 * @param groups - Audience groups in render order.
 * @returns The groups with each document's heading id, preamble and sections.
 */
export function layOutLegalPage(groups: readonly LegalGroup[]): LaidOutGroup[] {
  const seen = new Map<string, number>();
  function reserve(id: string): string {
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    return count === 1 ? id : `${id}-${count}`;
  }

  // The first group uses bare `privacy` / `terms`, the targets of the
  // `/privacy` and `/terms` redirects.
  const headed = groups.map((group, gi) => ({
    group,
    headingIds: perDoc((d) => reserve(gi === 0 ? d : docHeadingId(group.audience, d))),
  }));

  return headed.map(({ group, headingIds }) => ({
    audience: group.audience,
    label: group.label,
    docs: perDoc((d) => {
      const entry = group.content[d];
      const { preamble, sections } = splitIntoSections(entry.content, entry.title);
      return {
        entry,
        headingId: headingIds[d],
        preamble,
        sections: sections.map((section) => ({ ...section, id: reserve(section.id) })),
      };
    }),
  }));
}

/**
 * The rail entry to highlight for a document none of whose sections has been
 * reached: its first section, else its heading.
 */
export function firstPillId(doc: LaidOutDoc): string {
  return doc.sections[0]?.id ?? doc.headingId;
}
