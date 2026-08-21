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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { cn } from '../../lib/cn';
import { MarkdownContent } from '../forms/MarkdownContent';
import { extractSections, type LegalSection } from './legal-sections';
import type { ConsentDocContent } from '../consent/consent-types';
import { BlueDotsLogo } from '../ui/BlueDotsLogo';
import { useThemeMode } from '../../lib/theme-mode';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../hooks/useAggregatorConfig';
import { I } from '../../icons';

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
 * Renders the shared layout for `/privacy` and `/terms`: an app bar (brand
 * logo, back link, and a theme toggle), a contents rail grouped by
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
  const themeT = useTranslations('theme');
  const locale = useLocale();
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const { mode, toggle: toggleTheme } = useThemeMode();
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

  // Every id on the page that the scroll-spy and arrival fallback need, in
  // render order: each (group, document) pair's own structural heading id,
  // immediately followed by that document's section ids. Doc headings are
  // included (not just sections) so the spy can tell "this document's own
  // intro prose is on screen, none of its sections yet" apart from
  // "genuinely nothing has passed" (see `computeActiveId` below).
  const allSpyIds = useMemo(
    () =>
      groups.flatMap((group, gi) =>
        DOC_ORDER.flatMap((d) => [
          docIds[group.audience]![d]!,
          ...sectionsByDoc[d][gi]!.map((s) => s.id),
        ]),
      ),
    [groups, sectionsByDoc, docIds],
  );

  // The rail entry to highlight for a given (group, document) pair when no
  // section within it has actually scrolled past the reading line yet —
  // that document's own first section, or its own heading id when it has
  // none (an edge case; every real document has at least one section
  // today). Shared by the arrival landing and the scroll-spy so both fall
  // back to the same entry.
  const pillFallbackId = useCallback(
    (gi: number, d: LegalDoc): string | undefined => {
      const group = groups[gi];
      if (!group) return undefined;
      return sectionsByDoc[d][gi]?.[0]?.id ?? docIds[group.audience]?.[d];
    },
    [groups, sectionsByDoc, docIds],
  );

  // How close to the top of the viewport a heading must have scrolled to
  // count as "passed" — matches the `scroll-mt-6` (24px) offset headings
  // already carry, plus a little slack for the reading column's own top
  // padding.
  const READING_LINE_PX = 96;

  // How long to wait, after the most recent scroll event, before treating a
  // click-triggered scroll as settled and handing the highlight back to the
  // spy. A fixed debounce rather than a "smooth scroll finished" callback
  // (no such event is universally available) — each scroll event in flight
  // pushes the release out again, so a long smooth scroll is protected for
  // its whole duration, while a reduced-motion jump (at most one scroll
  // event) releases almost immediately.
  const SCROLL_SETTLE_MS = 150;

  // Kept alongside `activeSectionId` so `computeActiveId`'s no-candidate
  // branch (an empty page, defensively) has a same-render value to fall
  // back to without needing `activeSectionId` itself in its dependency
  // list.
  const activeIdRef = useRef(activeSectionId);
  activeIdRef.current = activeSectionId;

  // Scroll-spy: the rail's highlight follows whichever heading has most
  // recently scrolled past the reading line. Position-based (each heading's
  // own `getBoundingClientRect().top`), not an IntersectionObserver
  // percentage band — a band has to assume something about how tall a
  // section is, and a section shorter than the band lets the *next*
  // heading enter the band before the current one has genuinely been read,
  // so the pill jumps to it early (reproduction: the org audience's short
  // "Sharing" section). Comparing raw top-edge position makes no such
  // assumption: the active entry is just the last heading (in document
  // order) at or above `READING_LINE_PX`, which holds regardless of
  // section length.
  const computeActiveId = useCallback((): string | null => {
    const elements = allSpyIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return activeIdRef.current;

    // The last element (in document order) that has scrolled up past the
    // reading line — a document's own heading counts here too, so this
    // still finds something the moment a document's intro prose reaches
    // the top, before any of its sections have.
    let lastPassed: HTMLElement | null = null;
    for (const el of elements) {
      if (el.getBoundingClientRect().top <= READING_LINE_PX) {
        lastPassed = el;
      } else {
        break;
      }
    }

    // Nothing has passed yet — genuinely at the very top of the page.
    // Highlight the first audience group's first document's first section,
    // the same fallback a no-hash arrival at that document would use.
    if (!lastPassed) return pillFallbackId(0, DOC_ORDER[0]!) ?? null;

    for (let gi = 0; gi < groups.length; gi += 1) {
      const group = groups[gi]!;
      for (const d of DOC_ORDER) {
        if (docIds[group.audience]?.[d] === lastPassed.id) {
          // `lastPassed` is a document's own heading with none of its
          // sections reached yet — highlight its first section instead of
          // leaving the pill on a bare doc heading.
          return pillFallbackId(gi, d) ?? lastPassed.id;
        }
      }
    }
    // `lastPassed` is already a section id — it is the entry to highlight.
    return lastPassed.id;
  }, [allSpyIds, groups, docIds, pillFallbackId]);

  // A just-clicked rail entry, or a programmatic (arrival/deep-link) scroll,
  // is pinned for the duration of its scroll — otherwise the effect below
  // would recompute from transient mid-scroll geometry and the pill would
  // drift to whichever entry the scroll happens to be passing through
  // before resting on the intended one (the short-section defect this pin
  // exists to close).
  const pinnedIdRef = useRef<string | null>(null);
  const pinReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armPinRelease = useCallback(() => {
    if (pinReleaseTimerRef.current) clearTimeout(pinReleaseTimerRef.current);
    pinReleaseTimerRef.current = setTimeout(() => {
      pinnedIdRef.current = null;
      setActiveSectionId(computeActiveId());
    }, SCROLL_SETTLE_MS);
  }, [computeActiveId]);

  /**
   * Scrolls `targetElId` into view (if it exists) and pins the rail's
   * highlight to `pillId` for the duration of that scroll. The two can
   * differ: a no-hash arrival at a non-first document scrolls to that
   * *document's* heading but pills its *first section* instead.
   */
  const scrollAndPin = useCallback(
    (targetElId: string, pillId: string) => {
      setActiveSectionId(pillId);
      pinnedIdRef.current = pillId;
      armPinRelease();
      const el = document.getElementById(targetElId);
      if (el) scrollElementIntoView(el);
    },
    [armPinRelease],
  );

  function navigateTo(id: string) {
    scrollAndPin(id, id);
  }

  // Deep-link / arrival landing. The target is either the hash (deep link,
  // e.g. `/terms#grievances`) or, absent a hash, the first audience group's
  // heading for the routed document — unless that document is already the
  // first one on the page (`/privacy` with no hash), in which case it is
  // already at the top and there is nothing to scroll to.
  //
  // No-hash arrival never highlights a section on its own: every document
  // opens with intro prose before its first heading, so the scroll-spy has
  // nothing "passed" at scroll-top and highlights nothing. Rather than land
  // with the rail showing no pill at all, default the highlight to the
  // routed document's own first section within the first (topmost)
  // audience group — the same fallback `computeActiveId` uses once real
  // scrolling starts — not simply the first section on the page, which
  // would always be Privacy's even when the route is `/terms`.
  useEffect(() => {
    if (groups.length === 0) return;
    const hashId =
      typeof window !== 'undefined' && window.location.hash
        ? decodeURIComponent(window.location.hash.slice(1))
        : null;

    if (hashId) {
      if (document.getElementById(hashId)) scrollAndPin(hashId, hashId);
      return;
    }

    const fallbackDocId = docIds[groups[0]!.audience]?.[doc];
    const fallbackPillId = pillFallbackId(0, doc);
    if (doc !== DOC_ORDER[0] && fallbackDocId) {
      scrollAndPin(fallbackDocId, fallbackPillId ?? fallbackDocId);
    } else if (fallbackPillId) {
      // Already at the top — nothing to scroll to, so no pin needed either.
      setActiveSectionId(fallbackPillId);
    }
    // Deliberately keyed on `doc`/`groups.length`, not on every id recomputation.
  }, [doc, groups.length, docIds, pillFallbackId, scrollAndPin]);

  // Scroll-spy proper: recomputes the active id on scroll/resize, unless a
  // click or arrival scroll currently has it pinned (see `scrollAndPin`).
  useEffect(() => {
    if (allSpyIds.length === 0) return;

    function handleScroll() {
      if (pinnedIdRef.current) {
        // Still mid-flight: keep pushing the release out rather than
        // acting on this event, so a long smooth scroll stays pinned for
        // its whole duration.
        armPinRelease();
        return;
      }
      setActiveSectionId(computeActiveId());
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll);
    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [allSpyIds, computeActiveId, armPinRelease]);

  // Release a pin left over from an unmounted click (e.g. navigating away
  // mid-scroll) rather than leaking the timer.
  useEffect(() => {
    return () => {
      if (pinReleaseTimerRef.current) clearTimeout(pinReleaseTimerRef.current);
    };
  }, []);

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
        {/* App bar: the brand logo (this page previously had no branding at
            all, which is what made it look foreign next to the rest of the
            app), a way back to sign-in (someone can land here mid-signup
            with no other path back), and a theme toggle — composed from the
            same pieces the rest of the app's public pages (login/register)
            use for branding, plus a toggle mirroring `Topbar`'s own, rather
            than a portal shell built for an authenticated session:
            `Sidebar` (the app's real logo bar) pulls in `useAuth` for the
            signed-in user menu, none of which means anything on a public,
            unauthenticated legal page. No language switcher here — the
            `(public)` route group's own layout already floats one
            top-right for every route in it, this one included. The back
            link's label drops below `sm` (icon-only) so the logo plus
            theme toggle never wrap the row and overlap the content
            underneath at narrow widths. */}
        <div className="mb-8 flex min-h-14 flex-wrap items-center gap-3 border-b border-(--bd-border) pb-4">
          {cfg.brand.logo?.default ? (
            <Image
              src={cfg.brand.logo.default}
              alt={cfg.brand.short_name}
              width={160}
              height={40}
              priority
              className="h-9 w-auto shrink-0 object-contain object-left"
            />
          ) : (
            <div className="flex min-w-0 shrink-0 items-center gap-2.5">
              <BlueDotsLogo size={36} />
              <span className="truncate font-display text-[15px] font-bold leading-tight text-ink-900">
                {cfg.brand.short_name}
              </span>
            </div>
          )}

          <Link
            href="/login"
            aria-label={t('back_to_sign_in')}
            className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-ink-500 transition-colors hover:text-(--bd-primary-600)"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t('back_to_sign_in')}</span>
          </Link>

          {/* Language switching is already provided for every `(public)`
              route — including this one — by that route group's own
              layout (a fixed top-right control); adding a second instance
              here would just duplicate it. Only the theme toggle is new. */}
          <button
            type="button"
            onClick={toggleTheme}
            title={mode === 'dark' ? themeT('switch_to_light') : themeT('switch_to_dark')}
            aria-label={themeT('toggle_aria')}
            className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-(--bd-border) bg-(--bd-card) text-(--bd-fg-muted) transition-colors hover:bg-(--bd-border-soft) hover:text-(--bd-fg)"
          >
            {mode === 'dark' ? <I.sun size={16} /> : <I.moon size={16} />}
          </button>
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
