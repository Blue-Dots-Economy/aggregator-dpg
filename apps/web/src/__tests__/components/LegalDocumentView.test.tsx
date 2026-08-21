import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import { LegalDocumentView, type LegalGroup } from '@/components/legal/LegalDocumentView';

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
    expect(screen.getByText('For participants')).toBeInTheDocument();
    expect(screen.getByText('For aggregators')).toBeInTheDocument();
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

  it('captures no consent — there is no checkbox anywhere on the page', () => {
    renderView('terms', groups);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders a helpful empty state when no consent content loaded', () => {
    renderView('privacy', []);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('marks the routed document current within every audience group', () => {
    renderView('privacy', groups);
    const currentLinks = screen.getAllByRole('link', { name: 'Privacy Policy' });
    expect(currentLinks.length).toBeGreaterThan(0);
    for (const link of currentLinks) {
      expect(link).toHaveAttribute('aria-current', 'page');
    }
  });

  // Regression for the reported defect: the other document's rail entry used
  // to be a route Link (`href="/terms"`), so hovering it showed a full
  // navigation instead of an in-page anchor. Both documents already render
  // on this page, so it must be a same-page anchor with no aria-current
  // (the routed document is still Privacy Policy).
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

    for (const [label, audience] of [
      ['For participants', 'participant'],
      ['For aggregators', 'aggregator'],
      ['For organisations', 'org'],
    ] as const) {
      // Scope to this audience's rail group (the <div> wrapping its <p> label
      // and its two RailDocument rows).
      const groupContainer = screen.getByText(label).closest('div');
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
});
