import { describe, it, expect } from 'vitest';
import { firstPillId, layOutLegalPage, type LegalGroup } from '@/components/legal/legal-layout';

const doc = (title: string, content: string) => ({ version: 1, title, content });

const GROUPS: LegalGroup[] = [
  {
    audience: 'org',
    label: 'For organisations',
    content: {
      privacy: doc('Privacy Policy', '## Privacy Policy\n\nIntro.\n## Terms\nA clash.'),
      terms: doc('Terms of Service', 'No sections.'),
    },
  },
  {
    audience: 'aggregator',
    label: 'For aggregators',
    content: {
      privacy: doc('Privacy Policy', '## Overview\nx'),
      terms: doc('Terms of Service', '## Overview\ny'),
    },
  },
];

describe('layOutLegalPage', () => {
  it('reserves document heading ids before section ids, first group bare', () => {
    const [org, aggregator] = layOutLegalPage(GROUPS);
    expect(org?.docs.privacy.headingId).toBe('privacy');
    expect(org?.docs.terms.headingId).toBe('terms');
    expect(aggregator?.docs.privacy.headingId).toBe('aggregator-privacy');
    expect(org?.docs.privacy.sections.map((s) => s.id)).toEqual(['terms-2']);
    expect(aggregator?.docs.privacy.sections.map((s) => s.id)).toEqual(['overview']);
    expect(aggregator?.docs.terms.sections.map((s) => s.id)).toEqual(['overview-2']);
  });

  it('moves a repeated title heading into the preamble', () => {
    const [org] = layOutLegalPage(GROUPS);
    expect(org?.docs.privacy.preamble).toBe('Intro.');
    expect(org?.docs.terms.preamble).toBe('No sections.');
  });

  it('pills a document by its first section, else by its heading', () => {
    const [org] = layOutLegalPage(GROUPS);
    expect(org && firstPillId(org.docs.privacy)).toBe('terms-2');
    expect(org && firstPillId(org.docs.terms)).toBe('terms');
  });
});

describe('layOutLegalPage page-unique ids', () => {
  const allIds = (groups: LegalGroup[]) =>
    layOutLegalPage(groups).flatMap((g) => [
      g.headingId,
      ...(['privacy', 'terms'] as const).flatMap((d) => [
        g.docs[d].headingId,
        ...g.docs[d].sections.map((s) => s.id),
      ]),
    ]);

  it('never hands out a suffixed id that a later heading already slugs to', () => {
    const ids = allIds([
      {
        audience: 'org',
        label: 'For organisations',
        content: {
          privacy: doc('Privacy Policy', '## Terms\nx'),
          terms: doc('Terms of Service', '## Terms 2\ny'),
        },
      },
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reserves the audience heading id before any section id', () => {
    const [org] = layOutLegalPage([
      {
        audience: 'org',
        label: 'For organisations',
        content: {
          privacy: doc('Privacy Policy', '## Org audience\nx'),
          terms: doc('Terms of Service', 'y'),
        },
      },
    ]);
    expect(org?.headingId).toBe('org-audience');
    expect(org?.docs.privacy.sections.map((s) => s.id)).toEqual(['org-audience-2']);
  });
});
