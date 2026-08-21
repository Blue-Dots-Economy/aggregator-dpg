import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('links each extracted section as an anchor', () => {
    renderView('privacy', groups);
    expect(screen.getByRole('link', { name: 'Retention' })).toHaveAttribute('href', '#retention');
  });

  it('shows the version for each audience', () => {
    renderView('privacy', groups);
    expect(screen.getByText(/Version 1/)).toBeInTheDocument();
    expect(screen.getByText(/Version 2/)).toBeInTheDocument();
  });

  it('captures no consent — there is no checkbox anywhere on the page', () => {
    renderView('terms', groups);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders a helpful empty state when no consent content loaded', () => {
    renderView('privacy', []);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('marks the document being read with aria-current within its audience group', () => {
    renderView('privacy', groups);
    const currentLinks = screen.getAllByRole('link', { name: 'Privacy Policy' });
    expect(currentLinks.length).toBeGreaterThan(0);
    for (const link of currentLinks) {
      expect(link).toHaveAttribute('aria-current', 'page');
    }
  });

  it('links to the other document by route', () => {
    renderView('privacy', groups);
    const otherLinks = screen.getAllByRole('link', { name: 'Terms of Service' });
    expect(otherLinks.length).toBeGreaterThan(0);
    for (const link of otherLinks) {
      expect(link).toHaveAttribute('href', '/terms');
      expect(link).not.toHaveAttribute('aria-current');
    }
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

  it('gives colliding section ids across audiences a unique suffix so anchors do not clash', () => {
    const collidingGroups: LegalGroup[] = [
      {
        audience: 'participant',
        label: 'For participants',
        content: {
          privacy: {
            version: 1,
            title: 'Privacy Policy',
            content: '## Privacy Policy\n### Grievances\na',
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
            content: '## Privacy Policy\n### Grievances\nb',
          },
          terms: { version: 1, title: 'Terms of Service', content: '## Terms of Service' },
        },
      },
    ];
    renderView('privacy', collidingGroups);
    const headings = screen.getAllByRole('heading', { name: 'Grievances' });
    const ids = headings.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('grievances');
  });
});
