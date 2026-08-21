'use client';
/**
 * Read-only public legal page: all six documents — Privacy Policy and Terms
 * of Service, for each of the three audiences (participants / aggregators /
 * organisations) — in one continuous scroll, with a contents rail beside the
 * reading column.
 *
 * `/privacy` and `/terms` render the exact same page; the route only decides
 * which document the reader lands on (see the arrival effect below). Nothing
 * in the rail navigates to another route any more — every entry, at both the
 * document level and the section level, is a same-page anchor, because every
 * document already lives on the page.
 *
 * The aggregator carries three separate sets of consent documents (unlike
 * the sibling Signals-DPG repo's single audience), so the rail keeps its
 * existing three-level hierarchy — audience group, then document, then
 * sections — and the reading column nests the same way: one region per
 * audience, holding both of that audience's documents in turn.
 *
 * No checkbox, no scroll gating, no consent capture — that is the separate
 * `ConsentGate` surface, untouched by this read-only page.
 *
 * @module apps/web/src/components/legal/LegalDocumentView
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
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

const DOC_ORDER: LegalDoc[] = ['privacy', 'terms'];

type DocEntry = ConsentDocContent['terms'];

/** One rendered section: its rail metadata plus the markdown body that follows it. */
interface RenderableSection extends LegalSection {
  body: string;
}

/**
 * Structural id for one audience's one document heading — built from the
 * audience key and the document key, never from document content. This is
 * what the rail's document-level entry links to, and what a route arrival
 * with no hash scrolls to.
 */
function docHeadingId(audience: string, doc: LegalDoc): string {
  return `${audience}-${doc}`;
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
 * Markdown with no `##`/`###` headings at all (or only its own title
 * heading) yields an empty `sections` list and the whole body as `preamble`
 * — never a crash. Headings nested deeper than `###` are not treated as
 * section boundaries either; they stay put as ordinary content inside
 * whichever section (or the preamble) they fall under, and `MarkdownContent`
 * still renders them.
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
 * Assigns every anchor id on the page — one structural id per audience's
 * document heading, plus one per extracted section — so none collide once
 * all three audiences' Privacy Policy and Terms of Service render together
 * on a single continuous page.
 *
 * This is the one dedup mechanism both axes now go through, replacing what
 * were, before this fix, two separate and incomplete passes: `extractSections`'
 * own within-document dedup (guards only against one document repeating a
 * heading) and an earlier cross-*group*-only pass that didn't know about a
 * second document sharing the page. A single `seen` map is walked once, in
 * render order — group by group, and within each group document by document
 * — so a rail `href="#x"` for any of the three audiences' Terms *or* Privacy
 * always resolves to exactly one heading, and that heading belongs to that
 * same audience and document.
 *
 * Document-level structural ids are reserved in the same `seen` map before
 * any section id is assigned, so a section whose slugified heading happens
 * to collide with a structural id (e.g. a heading literally titled
 * "Participant Privacy") is renumbered instead of silently landing on — or
 * duplicating — the document anchor. Structural ids never collide with each
 * other on their own (audience, document) is already a unique pair), so this
 * only ever affects a content-derived section id.
 *
 * @param groups - Audience groups in render order.
 * @param splitByDoc - Each group's preamble + sections for each document,
 *   still carrying `extractSections`' own (unreconciled) ids.
 * @returns Each group's document heading ids, and the same sections with
 *   ids made unique across the whole page.
 */
function assignPageAnchorIds(
  groups: LegalGroup[],
  splitByDoc: Record<LegalDoc, { preamble: string; sections: RenderableSection[] }[]>,
): {
  docIds: Record<string, Record<LegalDoc, string>>;
  sectionsByDoc: Record<LegalDoc, RenderableSection[][]>;
} {
  const seen = new Map<string, number>();
  function reserve(id: string): string {
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    return count === 1 ? id : `${id}-${count}`;
  }

  const docIds: Record<string, Record<LegalDoc, string>> = {};
  for (const group of groups) {
    const perDoc = {} as Record<LegalDoc, string>;
    for (const d of DOC_ORDER) {
      perDoc[d] = reserve(docHeadingId(group.audience, d));
    }
    docIds[group.audience] = perDoc;
  }

  const sectionsByDoc = Object.fromEntries(
    DOC_ORDER.map((d) => [d, [] as RenderableSection[][]]),
  ) as Record<LegalDoc, RenderableSection[][]>;
  groups.forEach((group, gi) => {
    for (const d of DOC_ORDER) {
      sectionsByDoc[d][gi] = splitByDoc[d][gi]!.sections.map((section) => ({
        ...section,
        id: reserve(section.id),
      }));
    }
  });

  return { docIds, sectionsByDoc };
}

/**
 * Whether the browser has asked for reduced motion — checked at click/scroll
 * time (not cached) so a user who changes the OS setting mid-session is
 * respected immediately.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  );
}

/**
 * Scrolls an element into view, tolerating environments where
 * `scrollIntoView` doesn't exist — notably jsdom (this project's test
 * environment), which doesn't implement it at all, as opposed to providing
 * a no-op stub.
 */
function scrollElementIntoView(el: HTMLElement): void {
  el.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

/** Rail entry for one document's sections within an audience group. */
function RailSections({
  sections,
  activeSectionId,
  onNavigate,
}: {
  sections: LegalSection[];
  activeSectionId: string | null;
  onNavigate: (id: string) => void;
}) {
  if (sections.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {sections.map((section) => {
        const isActive = activeSectionId === section.id;
        return (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              aria-current={isActive ? 'true' : undefined}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(section.id);
              }}
              className={cn(
                'block rounded-md border-l-2 py-1 pl-3 text-[12.5px] transition-colors',
                isActive
                  ? 'border-(--bd-primary-600) bg-(--bd-primary-50) font-semibold text-(--bd-primary-600)'
                  : 'border-transparent text-ink-500 hover:bg-(--bd-border-soft) hover:text-ink-900',
              )}
            >
              {section.heading}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Renders one audience's document row inside the rail: the document title
 * (a same-page anchor to that document's heading within this audience) and
 * its section list. The version/effective-date line is shown once, in the
 * reading column, rather than repeated here.
 *
 * `sections` is passed in already deduped across the whole page (see
 * `assignPageAnchorIds`) — this component does not parse the Markdown
 * itself, so the rail's `href`s and the reading column's heading `id`s can
 * never drift apart.
 */
function RailDocument({
  isCurrent,
  entry,
  headingId,
  sections,
  activeSectionId,
  onNavigate,
}: {
  isCurrent: boolean;
  entry: DocEntry;
  headingId: string;
  sections: LegalSection[];
  activeSectionId: string | null;
  onNavigate: (id: string) => void;
}) {
  return (
    <div className={cn('mb-3', !isCurrent && 'opacity-60')}>
      <a
        href={`#${headingId}`}
        aria-current={isCurrent ? 'page' : undefined}
        onClick={(event) => {
          event.preventDefault();
          onNavigate(headingId);
        }}
        className={cn(
          'block rounded-md py-1 text-[10.5px] font-bold uppercase tracking-[0.1em] transition-colors',
          isCurrent
            ? 'text-(--bd-primary-600)'
            : 'text-ink-500 hover:bg-(--bd-border-soft) hover:text-(--bd-primary-600)',
        )}
      >
        {entry.title}
      </a>
      <RailSections sections={sections} activeSectionId={activeSectionId} onNavigate={onNavigate} />
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
 * Renders the shared layout for `/privacy` and `/terms`: an app bar (back
 * link + language control, separated by a rule), a contents rail grouped by
 * audience then document, and the reading column holding every audience's
 * both documents in one continuous scroll.
 *
 * @param props.doc - Which document this route lands the reader on:
 *   `privacy` or `terms`. Every document, for every audience, renders on the
 *   page either way.
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
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);

  // Split every audience's both documents' sections once, up front. The rail
  // (document + section anchors) and the reading column's headings for both
  // documents read from this same computation — one pass, shared consumers
  // — so a rail `href="#id"` and its matching heading's `id` cannot drift
  // apart.
  const splitByDoc = useMemo(
    () =>
      Object.fromEntries(
        DOC_ORDER.map((d) => [
          d,
          groups.map((group) =>
            splitIntoSections(group.content[d].content, group.content[d].title),
          ),
        ]),
      ) as Record<LegalDoc, { preamble: string; sections: RenderableSection[] }[]>,
    [groups],
  );

  const { docIds, sectionsByDoc } = useMemo(
    () => assignPageAnchorIds(groups, splitByDoc),
    [groups, splitByDoc],
  );

  // Every section id on the page, in render order, for the scroll-spy below.
  const allSectionIds = useMemo(
    () =>
      groups.flatMap((group, gi) =>
        DOC_ORDER.flatMap((d) => sectionsByDoc[d][gi]!.map((s) => s.id)),
      ),
    [groups, sectionsByDoc],
  );

  function navigateTo(id: string) {
    const el = document.getElementById(id);
    if (el) scrollElementIntoView(el);
    setActiveSectionId(id);
  }

  // Deep-link / arrival landing. The target is either the hash (deep link,
  // e.g. `/terms#grievances`) or, absent a hash, the first audience group's
  // heading for the routed document — unless that document is already the
  // first one on the page (`/privacy` with no hash), in which case it is
  // already at the top and there is nothing to scroll to.
  useEffect(() => {
    if (groups.length === 0) return;
    const hashId =
      typeof window !== 'undefined' && window.location.hash
        ? decodeURIComponent(window.location.hash.slice(1))
        : null;
    const fallbackId = doc !== DOC_ORDER[0] ? docIds[groups[0]!.audience]?.[doc] : undefined;
    const targetId = hashId ?? fallbackId;
    if (!targetId) return;
    const el = document.getElementById(targetId);
    if (!el) return;
    scrollElementIntoView(el);
    if (allSectionIds.includes(targetId)) setActiveSectionId(targetId);
    // Deliberately keyed on `doc`/`groups.length`, not on every id recomputation.
  }, [doc, groups.length]);

  // Scroll-spy: the rail's section highlight follows whichever section
  // heading is currently in view. jsdom (this project's test environment)
  // has no `IntersectionObserver` at all — not even a non-firing stub — so
  // this is skipped there entirely; fine, since clicking a rail entry sets
  // `activeSectionId` directly (see `navigateTo`) and tests cover that path
  // instead.
  useEffect(() => {
    if (allSectionIds.length === 0) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const elements = allSectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        for (let i = elements.length - 1; i >= 0; i -= 1) {
          if (visible.has(elements[i]!.id)) {
            setActiveSectionId(elements[i]!.id);
            break;
          }
        }
      },
      { rootMargin: '-15% 0px -75% 0px', threshold: 0 },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // Deliberately keyed on the id list, not element identity.
  }, [allSectionIds.join('|')]);

  if (groups.length === 0) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-(--bd-bg) px-6 py-12">
        <p role="status" className="text-sm text-ink-500">
          {t('unavailable')}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-svh bg-(--bd-bg) px-6 py-12">
      <div className="mx-auto max-w-5xl">
        {/* App bar: a way back to sign-in (someone can land here mid-signup
            with no other path back) plus the language control, separated
            from the content by a rule. */}
        <div className="mb-8 flex items-center justify-between gap-4 border-b border-(--bd-border) pb-4">
          <Link
            href="/login"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 transition-colors hover:text-(--bd-primary-600)"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('back_to_sign_in')}
          </Link>
        </div>

        <div className="grid gap-8 md:grid-cols-[240px_1fr] md:gap-10">
          <nav
            aria-label={t('contents_label')}
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
                    isCurrent={d === doc}
                    entry={group.content[d]}
                    headingId={docIds[group.audience]![d]!}
                    sections={sectionsByDoc[d][gi]!}
                    activeSectionId={activeSectionId}
                    onNavigate={navigateTo}
                  />
                ))}
              </div>
            ))}
          </nav>

          <div className="min-w-0 max-w-[72ch]">
            <h1 className="text-2xl font-bold text-ink-900">
              {doc === 'privacy' ? t('privacy_title') : t('terms_title')}
            </h1>

            {groups.map((group, gi) => (
              <section
                key={group.audience}
                aria-label={group.label}
                className="mt-10 border-t border-(--bd-border) pt-8 first:mt-6 first:border-t-0 first:pt-0"
              >
                {DOC_ORDER.map((d) => {
                  const entry = group.content[d];
                  const { preamble } = splitByDoc[d][gi]!;
                  const sections = sectionsByDoc[d][gi]!;
                  return (
                    <div key={d} id={docIds[group.audience]![d]} className="scroll-mt-6">
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
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
