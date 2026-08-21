'use client';
/**
 * Read-only public legal page: a contents rail grouped by audience — For
 * participants, For aggregators, For organisations — alongside the reading
 * column for whichever document (`privacy` / `terms`) this route is.
 *
 * The aggregator carries three separate sets of consent documents (unlike
 * the sibling Signals-DPG repo's single audience), so `/privacy` alone would
 * not say which policy a visitor is reading — the rail resolves that by
 * grouping per audience, each with its own version and effective date.
 *
 * No checkbox, no scroll gating, no consent capture — that is the separate
 * `ConsentGate` surface, untouched by this read-only page.
 *
 * @module apps/web/src/components/legal/LegalDocumentView
 */
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { cn } from '../../lib/cn';
import { MarkdownContent } from '../forms/MarkdownContent';
import { extractSections, type LegalSection } from './legal-sections';
import type { ConsentDocContent } from '../consent/consent-types';

export type LegalDoc = 'privacy' | 'terms';

/** One audience's rail group and its Terms/Privacy content. */
export interface LegalGroup {
  /** Stable audience key — `participant` | `aggregator` | `org`. */
  audience: string;
  /** Already-localized group label, e.g. "For participants". */
  label: string;
  /** This audience's versioned Terms + Privacy Policy content. */
  content: ConsentDocContent;
}

const ROUTE: Record<LegalDoc, string> = { privacy: '/privacy', terms: '/terms' };
const DOC_ORDER: LegalDoc[] = ['privacy', 'terms'];

type DocEntry = ConsentDocContent['terms'];

/** One rendered section: its rail metadata plus the markdown body that follows it. */
interface RenderableSection extends LegalSection {
  body: string;
}

/**
 * Normalizes heading text for a title comparison — case- and
 * whitespace-insensitive, so "Privacy Policy", "privacy policy", and
 * "Privacy   Policy" all match the same title.
 */
function normalizeHeadingText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when `heading` is the document's own title, repeated as a heading.
 *
 * Every real consent document's Markdown opens with a level-2 heading that
 * repeats the document's `title` field verbatim (`## Privacy Policy`,
 * `## Terms of Service`, …) — verified across all six network schemas, both
 * privacy and terms. Rendering that heading as an ordinary section would
 * duplicate the page's own `<h1>` and give the rail a first entry that just
 * repeats its own group header. This checks the title specifically, not "is
 * it the first heading" — a document that legitimately opens with
 * `## Overview` keeps that section.
 */
function isDocumentTitleHeading(heading: string, title: string): boolean {
  return normalizeHeadingText(heading) === normalizeHeadingText(title);
}

/**
 * Splits a document's markdown into its heading-delimited sections, pairing
 * each with the id `extractSections` would assign it. Rendering the headings
 * ourselves (rather than leaving them to `MarkdownContent`) is what lets each
 * one carry an `id` an anchor can land on.
 *
 * The document's own leading title heading (see `isDocumentTitleHeading`) is
 * dropped from the section list; any prose directly under it is folded into
 * the preamble so it isn't lost.
 *
 * @param markdown - The document body.
 * @param title - The document's title, so its own repeated heading can be
 *   told apart from a real first section.
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
    if (!inFence && /^(#{2,3})\s+(.*)$/.exec(line.trim())) {
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
 * Reassigns ids across every audience group's sections for a given document
 * so two audiences that happen to share a heading (all three consent
 * audiences carry a "Grievances" section, for example) don't collide into
 * duplicate DOM ids on the same `/privacy` or `/terms` page. Uses the same
 * first-occurrence-keeps-its-id, later-occurrences-get-a-numeric-suffix
 * scheme as `extractSections`' own within-document dedup, just applied once
 * more across the whole page.
 *
 * Computed once per document and shared by both consumers that need these
 * ids — the rail's `href="#id"` anchors and the reading column's `id="id"`
 * headings — so they read from the exact same array instead of each parsing
 * the Markdown again on its own and risking drifting apart (which is what
 * happened before this fix: the rail called `extractSections` fresh per
 * group with no cross-group dedup, so every audience's rail entry pointed at
 * the bare, undeduped id — e.g. three "Grievances" rail links all
 * `href="#grievances"` — while only the headings actually got the
 * `-2`/`-3` suffixes, so two of the three links silently jumped to the
 * wrong audience's section).
 *
 * @param sectionsPerGroup - Each audience group's sections for one document,
 *   in render order.
 * @returns The same sections, with `id` made unique across all of them.
 */
function dedupeAcrossGroups(sectionsPerGroup: RenderableSection[][]): RenderableSection[][] {
  const seen = new Map<string, number>();
  return sectionsPerGroup.map((sections) =>
    sections.map((section) => {
      const count = (seen.get(section.id) ?? 0) + 1;
      seen.set(section.id, count);
      return count === 1 ? section : { ...section, id: `${section.id}-${count}` };
    }),
  );
}

/** Rail entry for one document's sections within an audience group. */
function RailSections({
  doc,
  sections,
  isCurrent,
}: {
  doc: LegalDoc;
  sections: LegalSection[];
  isCurrent: boolean;
}) {
  if (sections.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {sections.map((section) => (
        <li key={section.id}>
          {isCurrent ? (
            <a
              href={`#${section.id}`}
              className="block rounded-md py-1 pl-3 text-xs text-ink-500 hover:bg-(--bd-border-soft) hover:text-ink-900"
            >
              {section.heading}
            </a>
          ) : (
            <Link
              href={`${ROUTE[doc]}#${section.id}`}
              className="block rounded-md py-1 pl-3 text-xs text-ink-500 hover:bg-(--bd-border-soft) hover:text-ink-900"
            >
              {section.heading}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Renders one audience's document row inside the rail: the document title
 * (the navigation itself, per audience) and its section list. The
 * version/effective-date line is shown once, in the reading column, rather
 * than repeated here — otherwise two audiences at the same version would
 * render the identical "Version N" text twice on one page.
 *
 * `sections` is passed in already deduped across audience groups (see
 * `dedupeAcrossGroups`) — this component does not parse the Markdown itself,
 * so the rail's `href`s and the reading column's heading `id`s can never
 * drift apart the way they did before this fix.
 */
function RailDocument({
  doc,
  isCurrent,
  entry,
  sections,
}: {
  doc: LegalDoc;
  isCurrent: boolean;
  entry: DocEntry;
  sections: LegalSection[];
}) {
  return (
    <div className={cn('mb-3', !isCurrent && 'opacity-60')}>
      <Link
        href={ROUTE[doc]}
        aria-current={isCurrent ? 'page' : undefined}
        className={cn(
          'block rounded-md py-1 text-[13px] font-semibold',
          isCurrent ? 'text-ink-900' : 'text-ink-500 hover:text-ink-900',
        )}
      >
        {entry.title}
      </Link>
      <RailSections doc={doc} sections={sections} isCurrent={isCurrent} />
    </div>
  );
}

/**
 * Formats the "Version N · Effective DATE" line for one document entry,
 * localized via the `legal` message namespace. Falls back to "Version N"
 * alone when the entry carries no `effective_from` (older config content).
 */
function formatVersionLabel(
  entry: DocEntry,
  t: ReturnType<typeof useTranslations>,
  locale: string,
): string {
  if (!entry.effective_from) return t('version_only', { version: entry.version });
  const date = new Date(entry.effective_from);
  const formatted = Number.isNaN(date.getTime())
    ? entry.effective_from
    : new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(date);
  return t('version_effective', { version: entry.version, date: formatted });
}

/**
 * Renders the shared layout for `/privacy` and `/terms`: a contents rail
 * grouped by audience beside the reading column for the current `doc`.
 *
 * @param props.doc - Which document this route reads: `privacy` or `terms`.
 * @param props.groups - One entry per audience whose consent content loaded;
 *   an audience whose content failed to load is simply absent here (see
 *   `load-legal-groups.server.ts`) rather than throwing.
 */
export function LegalDocumentView({
  doc,
  groups,
}: {
  doc: LegalDoc;
  groups: LegalGroup[];
}): JSX.Element {
  const t = useTranslations('legal');
  const locale = useLocale();

  if (groups.length === 0) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-(--bd-bg) px-6 py-12">
        <p role="status" className="text-sm text-ink-500">
          {t('unavailable')}
        </p>
      </div>
    );
  }

  // Split + cross-group-dedupe *both* documents' sections once, up front,
  // keyed by doc then by group index. The rail (current-doc anchors, other-
  // doc route links) and the reading column's headings for the current doc
  // both read from this same array — one computation, shared consumers — so
  // a rail `href="#id"` and its matching heading's `id` cannot drift apart
  // the way they did before this fix.
  const splitByDoc = Object.fromEntries(
    DOC_ORDER.map((d) => [
      d,
      groups.map((group) => splitIntoSections(group.content[d].content, group.content[d].title)),
    ]),
  ) as Record<LegalDoc, { preamble: string; sections: RenderableSection[] }[]>;

  const dedupedSectionsByDoc = Object.fromEntries(
    DOC_ORDER.map((d) => [d, dedupeAcrossGroups(splitByDoc[d].map((s) => s.sections))]),
  ) as Record<LegalDoc, RenderableSection[][]>;

  return (
    <div className="min-h-svh bg-(--bd-bg) px-6 py-12">
      <div className="mx-auto max-w-5xl">
        <div className="grid gap-8 md:grid-cols-[240px_1fr] md:gap-10">
          <nav
            aria-label="Contents"
            className="md:sticky md:top-6 md:h-fit md:self-start md:border-r md:border-(--bd-border) md:pr-6"
          >
            {groups.map((group, gi) => (
              <div key={group.audience} className="mb-6">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-ink-500">
                  {group.label}
                </p>
                {DOC_ORDER.map((d) => (
                  <RailDocument
                    key={d}
                    doc={d}
                    isCurrent={d === doc}
                    entry={group.content[d]}
                    sections={dedupedSectionsByDoc[d][gi]!}
                  />
                ))}
              </div>
            ))}
          </nav>

          <div className="min-w-0 max-w-[72ch]">
            <h1 className="text-2xl font-bold text-ink-900">
              {doc === 'privacy' ? t('privacy_title') : t('terms_title')}
            </h1>

            {groups.map((group, i) => {
              const entry = group.content[doc];
              const { preamble } = splitByDoc[doc][i]!;
              const sections = dedupedSectionsByDoc[doc][i]!;
              return (
                <section
                  key={group.audience}
                  aria-label={group.label}
                  className="mt-10 border-t border-(--bd-border) pt-8 first:mt-6 first:border-t-0 first:pt-0"
                >
                  <p className="mb-4 text-xs text-ink-500">
                    {formatVersionLabel(entry, t, locale)}
                  </p>

                  {preamble && <MarkdownContent content={preamble} />}

                  {sections.map((section) =>
                    section.level === 2 ? (
                      <div key={section.id}>
                        <h2
                          id={section.id}
                          className="mt-8 mb-2 scroll-mt-6 text-lg font-bold text-ink-900"
                        >
                          {section.heading}
                        </h2>
                        {section.body && <MarkdownContent content={section.body} />}
                      </div>
                    ) : (
                      <div key={section.id}>
                        <h3
                          id={section.id}
                          className="mt-6 mb-2 scroll-mt-6 text-base font-semibold text-ink-900"
                        >
                          {section.heading}
                        </h3>
                        {section.body && <MarkdownContent content={section.body} />}
                      </div>
                    ),
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
