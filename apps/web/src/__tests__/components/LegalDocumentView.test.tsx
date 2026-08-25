import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import type * as UseAggregatorConfigModule from '@/hooks/useAggregatorConfig';
import messages from '@/i18n/messages/en.json';
import { LegalDocumentView, type LegalGroup } from '@/components/legal/LegalDocumentView';

// The app bar (item 2 of the consent-scroll-gate port) reads the brand logo
// and theme mode. Neither is under test here, so both are stubbed to their
// real defaults (`useAggregatorConfig` re-exports the actual
// `DEFAULT_AGGREGATOR_CONFIG`, which carries no brand logo, so the page
// falls back to `BlueDotsLogo`) rather than requiring a real
// `QueryClientProvider` in every test's render tree.
vi.mock('@/hooks/useAggregatorConfig', async () => {
  const actual = await vi.importActual<typeof UseAggregatorConfigModule>(
    '@/hooks/useAggregatorConfig',
  );
  return {
    ...actual,
    useAggregatorConfig: () => ({ data: undefined, isError: false }),
  };
});
vi.mock('@/lib/theme-mode', () => ({
  useThemeMode: () => ({ mode: 'light', setMode: vi.fn(), toggle: vi.fn() }),
}));

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

function renderView(doc: 'privacy' | 'terms', groups: LegalGroup[]) {
  return render(
    <Wrapper>
      <LegalDocumentView doc={doc} groups={groups} />
    </Wrapper>,
  );
}

// Illustrative fixture used by most tests below — general rendering behaviour
// (rail groups, anchors, version display, no-checkbox, empty state) that does
// not turn on the leading-title-heading trap.
const groups: LegalGroup[] = [
  {
    audience: 'participant',
    label: 'For participants',
    content: {
      privacy: { version: 1, title: 'Privacy Policy', content: '## Overview\n### Retention\nx' },
      terms: { version: 1, title: 'Terms of Service', content: '## Overview' },
    },
  },
  {
    audience: 'aggregator',
    label: 'For aggregators',
    content: {
      privacy: { version: 2, title: 'Privacy Policy', content: '## Overview' },
      terms: { version: 2, title: 'Terms of Service', content: '## Overview' },
    },
  },
];

describe('<LegalDocumentView />', () => {
  it('renders a rail group per audience', () => {
    renderView('privacy', groups);
    // Each audience's label now renders twice — once in the rail, once as
    // the reading column's audience-boundary heading (see the "audience
    // boundary is legible" fix) — so this scopes to the rail specifically.
    const nav = screen.getByRole('navigation', { name: 'Contents' });
    expect(within(nav).getByText('For participants')).toBeInTheDocument();
    expect(within(nav).getByText('For aggregators')).toBeInTheDocument();
  });

  it('links each extracted section as a same-page anchor', () => {
    renderView('privacy', groups);
    expect(screen.getByRole('link', { name: 'Retention' })).toHaveAttribute('href', '#retention');
  });

  // Both of an audience's documents now render together, so each version
  // number appears once per document — twice per audience in this fixture,
  // since both of participant's documents (and both of aggregator's) share a
  // version number.
  it('shows the version for each audience and each document', () => {
    renderView('privacy', groups);
    expect(screen.getAllByText(/Version 1/)).toHaveLength(2);
    expect(screen.getAllByText(/Version 2/)).toHaveLength(2);
  });

  // Regression for the reported defect: scrolling from one document's
  // content into the next used to give no indication a new document had
  // started (the title appeared once, at the very top of the page, and
  // never again). Every document — for every audience — now carries its own
  // title heading right where its content begins, sourced from the `title`
  // field.
  it("renders each document's own title where its content begins, for every document", () => {
    renderView('privacy', groups);
    expect(screen.getAllByRole('heading', { name: 'Privacy Policy' })).toHaveLength(2);
    expect(screen.getAllByRole('heading', { name: 'Terms of Service' })).toHaveLength(2);
  });

  // Regression for the sibling defect: nothing in the reading column marked
  // where one audience's documents ended and the next audience's began.
  it('makes the audience boundary legible in the reading column', () => {
    renderView('privacy', groups);
    expect(screen.getByRole('heading', { name: 'For participants' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'For aggregators' })).toBeInTheDocument();
  });

  it('captures no consent — there is no checkbox anywhere on the page', () => {
    renderView('terms', groups);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders a helpful empty state when no consent content loaded', () => {
    renderView('privacy', []);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  // Regression for the reported defect: every audience's "Privacy Policy"
  // rail heading used to light up blue on `/privacy`, because "current" was
  // derived from the route (which document *kind*) rather than from where
  // the reader actually is. All six documents live on one page now, so
  // every "Privacy Policy" heading matches the route equally — the fix is
  // that the route must not drive any document-level styling at all.
  it('does not tint every same-named document heading — the route no longer drives document styling', () => {
    renderView('privacy', groups);
    const privacyLinks = screen.getAllByRole('link', { name: 'Privacy Policy' });
    expect(privacyLinks).toHaveLength(2);
    // Identical classes — no "current document" tint on either.
    expect(privacyLinks[0]!.className).toBe(privacyLinks[1]!.className);
  });

  // Regression for the surviving half of the same defect: once the visual
  // tint was removed, `aria-current="page"` stayed behind on every
  // document-heading anchor, still route-derived — so a screen reader
  // announced all of a route's same-named document headings as "current"
  // (verified: three "current page" hits on `/terms`, none on `/privacy`).
  // "Which document is current" isn't a fact the route knows on a page that
  // renders every document at once, so the attribute is dropped from the
  // document heading entirely — the section pill is the one live indicator.
  it('never puts aria-current on a document-heading anchor, on either route', () => {
    renderView('privacy', groups);
    for (const link of screen.getAllByRole('link', { name: /Privacy Policy|Terms of Service/ })) {
      expect(link).not.toHaveAttribute('aria-current');
    }
  });

  // Regression for the sibling defect: the non-routed document ("Terms of
  // Service" on `/privacy`) used to render its whole rail row — heading and
  // sections alike — at reduced opacity, reading as disabled even though
  // every entry is perfectly clickable. Every document row must look the
  // same regardless of which document (or route) is "current".
  it('does not dim the other document — every document row looks the same', () => {
    renderView('privacy', groups);
    const privacyLink = screen.getAllByRole('link', { name: 'Privacy Policy' })[0]!;
    const termsLink = screen.getAllByRole('link', { name: 'Terms of Service' })[0]!;
    expect(privacyLink.className).toBe(termsLink.className);
    expect(privacyLink.closest('div')?.className).not.toMatch(/opacity/);
    expect(termsLink.closest('div')?.className).not.toMatch(/opacity/);
  });

  // /privacy and /terms must render an identical-looking rail — the route
  // only decides which document the reader lands on (which, in turn,
  // legitimately moves the scroll-spy's single pill), never how a document
  // heading is styled. Compares the document-level rail entries' classes
  // specifically, not the section pill, which is expected to differ between
  // the two routes' different arrival positions.
  it('styles every document row identically on /privacy and /terms', () => {
    const { unmount } = renderView('privacy', groups);
    const privacyClasses = screen
      .getAllByRole('link', { name: /Privacy Policy|Terms of Service/ })
      .map((link) => link.className)
      .sort();
    unmount();

    renderView('terms', groups);
    const termsClasses = screen
      .getAllByRole('link', { name: /Privacy Policy|Terms of Service/ })
      .map((link) => link.className)
      .sort();

    expect(termsClasses).toEqual(privacyClasses);
  });

  // Regression for an older defect: this rail entry used to be a route
  // `Link` (`href="/terms"`), so hovering it showed a full navigation
  // instead of an in-page anchor. Both documents already render on this
  // page, so it must be a same-page anchor. Neither carries aria-current —
  // document-heading anchors never do, regardless of scroll position (see
  // the dedicated test above).
  it('links to the other document as a same-page anchor, not a route', () => {
    renderView('privacy', groups);
    const otherLinks = screen.getAllByRole('link', { name: 'Terms of Service' });
    expect(otherLinks).toHaveLength(2);
    expect(otherLinks.map((l) => l.getAttribute('href')).sort()).toEqual([
      '#aggregator-terms',
      '#participant-terms',
    ]);
    for (const link of otherLinks) {
      expect(link).not.toHaveAttribute('aria-current');
    }
  });

  it('uses the i18n contents label for the rail, not a hardcoded string', () => {
    renderView('privacy', groups);
    expect(screen.getByRole('navigation', { name: 'Contents' })).toBeInTheDocument();
  });

  it('has a back-to-sign-in link', () => {
    renderView('privacy', groups);
    expect(screen.getByRole('link', { name: /Back to sign in/i })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('clicking a rail section scrolls it into view and highlights it', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    renderView('privacy', groups);

    const link = screen.getByRole('link', { name: 'Retention' });
    fireEvent.click(link);

    expect(scrollIntoView).toHaveBeenCalled();
    expect(link).toHaveAttribute('aria-current', 'true');
  });

  it("clicking the other document's rail header scrolls to its heading", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    renderView('privacy', groups);

    const [termsHeader] = screen.getAllByRole('link', { name: 'Terms of Service' });
    fireEvent.click(termsHeader!);

    expect(scrollIntoView).toHaveBeenCalled();
  });

  // --- Trap 1 regression: every real consent document opens with a `##`
  // heading that repeats its own `title` verbatim. Fixture built with the
  // real shape (leading `## Privacy Policy`), per the corrected brief — a
  // fixture that opens with `## Overview` (the sibling's original mistake)
  // would never exercise this bug. ---
  const realShapeGroups: LegalGroup[] = [
    {
      audience: 'participant',
      label: 'For participants',
      content: {
        privacy: {
          version: 1,
          title: 'Privacy Policy',
          content: '## Privacy Policy\n\nIntro paragraph.\n### Retention\nx',
          effective_from: '2026-07-01',
        },
        terms: {
          version: 1,
          title: 'Terms of Service',
          content: '## Terms of Service\n\nWelcome.',
          effective_from: '2026-07-01',
        },
      },
    },
  ];

  it('does not repeat the document title as a second heading or as the rail’s first section', () => {
    renderView('privacy', realShapeGroups);
    // Exactly one heading reads "Privacy Policy" — the page's own <h1>, not a
    // duplicated <h2> for the leading `## Privacy Policy` in the markdown.
    expect(screen.getAllByRole('heading', { name: 'Privacy Policy' })).toHaveLength(1);
    // The rail's first (and only real) section entry is "Retention" — the
    // leading title heading must not appear as a rail entry of its own.
    expect(screen.getAllByRole('link', { name: 'Retention' })).toHaveLength(1);
  });

  it('keeps a section that legitimately opens with a non-title heading like Overview', () => {
    const overviewGroups: LegalGroup[] = [
      {
        audience: 'participant',
        label: 'For participants',
        content: {
          privacy: {
            version: 1,
            title: 'Privacy Policy',
            content: '## Overview\n\nSomething else entirely.',
          },
          terms: {
            version: 1,
            title: 'Terms of Service',
            content: '## Terms of Service\n\nWelcome.',
          },
        },
      },
    ];
    renderView('privacy', overviewGroups);
    expect(screen.getByRole('heading', { name: 'Overview' })).toHaveAttribute('id', 'overview');
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '#overview');
  });

  it('renders the heading it links to, so the anchor actually lands', () => {
    renderView('privacy', realShapeGroups);
    const heading = screen.getByRole('heading', { name: 'Retention' });
    expect(heading).toHaveAttribute('id', 'retention');
  });

  it('renders a document with no ### headings at all, without crashing', () => {
    const noSubsectionGroups: LegalGroup[] = [
      {
        audience: 'participant',
        label: 'For participants',
        content: {
          privacy: {
            version: 1,
            title: 'Privacy Policy',
            content: '## Privacy Policy\n\nJust a paragraph, no subsections at all.',
          },
          terms: {
            version: 1,
            title: 'Terms of Service',
            content: '## Terms of Service\n\nWelcome.',
          },
        },
      },
    ];
    renderView('privacy', noSubsectionGroups);
    expect(screen.getByText('Just a paragraph, no subsections at all.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
  });

  it('renders a document with five levels of heading nesting, without crashing', () => {
    const deepNestingGroups: LegalGroup[] = [
      {
        audience: 'participant',
        label: 'For participants',
        content: {
          privacy: {
            version: 1,
            title: 'Privacy Policy',
            content:
              '## Privacy Policy\n\n### A section\nintro\n#### A subsection\nmore\n##### Deeper still\neven more\n###### Deepest\ndeepest text',
          },
          terms: {
            version: 1,
            title: 'Terms of Service',
            content: '## Terms of Service\n\nWelcome.',
          },
        },
      },
    ];
    renderView('privacy', deepNestingGroups);
    expect(screen.getByRole('heading', { name: 'A section' })).toBeInTheDocument();
    expect(screen.getByText('deepest text')).toBeInTheDocument();
  });

  // Three audiences, all carrying a colliding "### Grievances" section under
  // Privacy Policy — the real shape: every real audience's Privacy Policy
  // document has one (verified against the live config).
  const collidingGroups: LegalGroup[] = [
    {
      audience: 'participant',
      label: 'For participants',
      content: {
        privacy: {
          version: 1,
          title: 'Privacy Policy',
          content: '## Privacy Policy\n### Grievances\nparticipant body',
        },
        terms: { version: 1, title: 'Terms of Service', content: '## Terms of Service' },
      },
    },
    {
      audience: 'aggregator',
      label: 'For aggregators',
      content: {
        privacy: {
          version: 1,
          title: 'Privacy Policy',
          content: '## Privacy Policy\n### Grievances\naggregator body',
        },
        terms: { version: 1, title: 'Terms of Service', content: '## Terms of Service' },
      },
    },
    {
      audience: 'org',
      label: 'For organisations',
      content: {
        privacy: {
          version: 1,
          title: 'Privacy Policy',
          content: '## Privacy Policy\n### Grievances\norg body',
        },
        terms: { version: 1, title: 'Terms of Service', content: '## Terms of Service' },
      },
    },
  ];

  it('gives colliding section ids across audiences a unique suffix so anchors do not clash', () => {
    renderView('privacy', collidingGroups);
    const headings = screen.getAllByRole('heading', { name: 'Grievances' });
    const ids = headings.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('grievances');
  });

  // Regression for a half-fix: cross-group dedup was applied to the rendered
  // headings but not threaded into the rail's hrefs, so all three "Grievances"
  // rail links pointed at the same bare "#grievances" — two of three silently
  // jumped to the wrong audience's section instead of their own. This proves
  // *correspondence* (each rail entry's href resolves to exactly one heading,
  // which belongs to that same audience's reading section), not just that the
  // heading ids happen to be unique.
  //
  // Extended for this port to also prove the same correspondence one level up
  // the hierarchy: each audience's own *document*-level rail entry (its
  // "Privacy Policy" / "Terms of Service" row) resolves to that same
  // audience's document block too, now that every audience's every document
  // shares one page and one id namespace.
  it('each audience group’s rail link resolves to that same audience’s heading, not another’s', () => {
    const { container } = renderView('privacy', collidingGroups);
    const nav = screen.getByRole('navigation', { name: 'Contents' });

    for (const [label, audience] of [
      ['For participants', 'participant'],
      ['For aggregators', 'aggregator'],
      ['For organisations', 'org'],
    ] as const) {
      // Scope to this audience's rail group (the <div> wrapping its <p> label
      // and its two RailDocument rows). Scoped to the rail (`nav`), not the
      // whole page — the audience label also renders as the reading
      // column's audience-boundary heading now, so an unscoped
      // `getByText(label)` would match twice.
      const groupContainer = within(nav).getByText(label).closest('div');
      expect(groupContainer).not.toBeNull();

      // --- section-level correspondence ---
      const link = within(groupContainer!).getByRole('link', { name: 'Grievances' });
      const href = link.getAttribute('href');
      expect(href).toMatch(/^#/);
      const targetId = href!.slice(1);

      // Exactly one element carries that id.
      const matches = container.querySelectorAll(`#${CSS.escape(targetId)}`);
      expect(matches).toHaveLength(1);
      const heading = matches[0]!;
      expect(heading.tagName).toBe('H3');
      expect(heading.textContent).toBe('Grievances');

      // And it must live inside *this* audience's reading section, not
      // another audience's — the actual bug: an org rail link landing on the
      // participant heading because both rendered as bare "#grievances".
      const readingSection = screen.getByRole('region', { name: label });
      expect(readingSection.contains(heading)).toBe(true);

      // Sanity: the section's body text is this audience's own copy, not a
      // different audience's — confirms we didn't just get lucky landing on
      // *a* Grievances heading that happens to sit inside the right section.
      expect(readingSection.textContent).toContain(`${audience} body`);

      // --- document-level correspondence ---
      const privacyDocLink = within(groupContainer!).getByRole('link', { name: 'Privacy Policy' });
      const docHref = privacyDocLink.getAttribute('href');
      expect(docHref).toMatch(/^#/);
      const docTargetId = docHref!.slice(1);
      const docMatches = container.querySelectorAll(`#${CSS.escape(docTargetId)}`);
      expect(docMatches).toHaveLength(1);
      expect(readingSection.contains(docMatches[0]!)).toBe(true);
      // Structural, not content-derived — carries the audience key itself.
      expect(docTargetId).toBe(`${audience}-privacy`);
    }
  });
});

describe('<LegalDocumentView /> arrival landing', () => {
  it('does nothing on /privacy with no hash — privacy is already the top of the page', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    renderView('privacy', groups);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls to the first audience’s terms heading when arriving at /terms with no hash', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    renderView('terms', groups);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  // Both documents open with intro prose before their first heading, so at
  // scroll-top the scroll-spy has nothing "in view" to highlight on its own
  // — without a fallback, the rail would land with no pill at all. Each
  // route's first section must be pilled on arrival, and it must be that
  // ROUTE's document's first section specifically (not merely whichever
  // section happens to render first on the page, which is always the first
  // audience's Privacy Policy).
  const BOTH_HAVE_SECTIONS: LegalGroup[] = [
    {
      audience: 'participant',
      label: 'For participants',
      content: {
        privacy: {
          version: 1,
          title: 'Privacy Policy',
          content: '## Privacy Policy\n\nIntro.\n### Retention\nx',
        },
        terms: {
          version: 1,
          title: 'Terms of Service',
          content: '## Terms of Service\n\nWelcome.\n### Governing law\nIndia.',
        },
      },
    },
  ];

  it('pills the first section on arrival at /privacy', () => {
    renderView('privacy', BOTH_HAVE_SECTIONS);
    expect(screen.getByRole('link', { name: 'Retention' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: 'Governing law' })).not.toHaveAttribute('aria-current');
  });

  it('pills the first section on arrival at /terms — Terms’ own first section, not Privacy’s', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    renderView('terms', BOTH_HAVE_SECTIONS);
    expect(screen.getByRole('link', { name: 'Governing law' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Retention' })).not.toHaveAttribute('aria-current');
  });
});

describe('<LegalDocumentView /> click pins the highlight through its scroll', () => {
  // Reproduction: a rail entry whose section body is short enough that the
  // FOLLOWING heading also ends up within the scroll-spy's "passed the
  // reading line" reach while the click's scroll is still in flight.
  // Without a pin, that transient geometry would win and the pill would
  // drift to the next entry down instead of staying on the one just
  // clicked — the real defect found on this repo's org audience's own
  // short "Sharing" section.
  const SHORT_SECTION_GROUPS: LegalGroup[] = [
    {
      audience: 'org',
      label: 'For organisations',
      content: {
        privacy: {
          version: 1,
          title: 'Privacy Policy',
          content:
            '## Privacy Policy\n\nIntro.\n### First\nBody one.\n### Sharing\nx\n### Third\nBody three.',
        },
        terms: {
          version: 1,
          title: 'Terms of Service',
          content: '## Terms of Service\n\nWelcome.',
        },
      },
    },
  ];

  function mockTop(id: string, top: number) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top,
      bottom: top + 20,
      left: 0,
      right: 0,
      width: 0,
      height: 20,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
  }

  beforeEach(() => {
    Element.prototype.scrollIntoView =
      vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the clicked short "Sharing" section highlighted through a misleading mid-scroll read, and after settling', () => {
    vi.useFakeTimers();
    renderView('privacy', SHORT_SECTION_GROUPS);

    const sharingLink = screen.getByRole('link', { name: 'Sharing' });
    fireEvent.click(sharingLink);
    expect(sharingLink).toHaveAttribute('aria-current', 'true');

    // Mid-flight: geometry momentarily suggests "Third" has also passed the
    // reading line (the short-section overshoot). A spy with no pin would
    // jump to it right here.
    mockTop('org-privacy', 0);
    mockTop('first', -50);
    mockTop('sharing', 10);
    mockTop('third', 50);
    fireEvent.scroll(window);

    expect(screen.getByRole('link', { name: 'Sharing' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: 'Third' })).not.toHaveAttribute('aria-current');

    // Settled: the transient reading was transient — at rest, only
    // "Sharing" has actually reached the reading line.
    mockTop('third', 150);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByRole('link', { name: 'Sharing' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: 'Third' })).not.toHaveAttribute('aria-current');
  });
});
