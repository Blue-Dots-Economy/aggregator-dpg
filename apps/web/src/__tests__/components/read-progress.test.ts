import { describe, it, expect } from 'vitest';
import { renderHook, fireEvent } from '@testing-library/react';
import type { RefObject } from 'react';
import { computeReadProgress, useReadProgress } from '@/components/consent/read-progress';
import type { ConsentDoc } from '@/components/consent/consent-docs';

// Three 300px sections stacked in a 200px-tall viewport.
const sections = [
  { id: 'privacy', top: 0, height: 300 },
  { id: 'terms', top: 300, height: 300 },
  { id: 'profile', top: 600, height: 300 },
];
const scroll = (scrollTop: number) => ({ scrollTop, clientHeight: 200, scrollHeight: 900 });

describe('computeReadProgress', () => {
  it('marks nothing read at the top and makes the first section current', () => {
    const p = computeReadProgress(scroll(0), sections, []);
    expect(p.readIds).toEqual([]);
    expect(p.currentId).toBe('privacy');
    expect(p.allRead).toBe(false);
  });

  it('marks a section read once its bottom passes the viewport bottom', () => {
    // viewport bottom = 100 + 200 = 300 === privacy bottom
    const p = computeReadProgress(scroll(100), sections, []);
    expect(p.readIds).toEqual(['privacy']);
    expect(p.currentId).toBe('terms');
  });

  it('advances fill continuously through the section in hand', () => {
    // privacy read (1 of 2 segments = 50%), halfway through terms adds 25%
    const p = computeReadProgress(scroll(250), sections, []);
    expect(p.readIds).toEqual(['privacy']);
    expect(p.fillPercent).toBeGreaterThan(50);
    expect(p.fillPercent).toBeLessThan(100);
  });

  it('reports every section read and 100% fill at the bottom', () => {
    const p = computeReadProgress(scroll(700), sections, []);
    expect(p.readIds).toEqual(['privacy', 'terms', 'profile']);
    expect(p.currentId).toBeNull();
    expect(p.allRead).toBe(true);
    expect(p.fillPercent).toBe(100);
  });

  it('keeps sections read after scrolling back up', () => {
    const p = computeReadProgress(scroll(0), sections, ['privacy', 'terms']);
    expect(p.readIds).toEqual(['privacy', 'terms']);
    expect(p.currentId).toBe('profile');
  });

  it('treats unscrollable content as fully read — the 111-character case', () => {
    const short = [{ id: 'profile', top: 0, height: 40 }];
    const p = computeReadProgress({ scrollTop: 0, clientHeight: 200, scrollHeight: 40 }, short, []);
    expect(p.allRead).toBe(true);
    expect(p.readIds).toEqual(['profile']);
  });

  it('reports allRead for an empty document list rather than blocking forever', () => {
    const p = computeReadProgress(scroll(0), [], []);
    expect(p.allRead).toBe(true);
    expect(p.currentId).toBeNull();
  });

  it('treats an unmeasured 0x0 container as nothing-read, not everything-read', () => {
    const p = computeReadProgress({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 }, sections, []);
    expect(p.allRead).toBe(false);
    expect(p.readIds).toEqual([]);
    expect(p.currentId).toBe('privacy');
  });

  // computeReadProgress derives its output readIds by filtering `sections`
  // (`sections.filter((s) => read.has(s.id))`), so a section absent from that
  // call's `sections` array is correctly absent from the output — the pure
  // function has nothing to say about a section it was never shown. That is
  // fine and expected; it is not where the sticky-read guarantee lives.
  it("drops a section from its output readIds when that call's sections omit it, even though it was already read — by design", () => {
    const short = [sections[1]!]; // 'terms' only; 'privacy' section missing this call
    const p = computeReadProgress(scroll(0), short, ['privacy']);
    expect(p.readIds).toEqual([]);
  });
});

// The sticky-read guarantee ("scrolling back up cannot un-read a document")
// is bookkeeping the *hook* owns, not something computeReadProgress can
// enforce on its own — it only sees whatever `sections` the hook hands it on
// a given call. Pinned here, not in the computeReadProgress suite above.
describe('useReadProgress', () => {
  const docs: ConsentDoc[] = [
    { id: 'privacy', cap: 'Privacy', title: 'Privacy Policy', body: 'p' },
    { id: 'terms', cap: 'Terms', title: 'Terms of Service', body: 't' },
  ];

  /** Builds the reader element's section children, optionally omitting one. */
  function setSections(el: HTMLElement, omit?: string) {
    el.innerHTML = '';
    const offsets: Record<string, { top: number; height: number }> = {
      privacy: { top: 0, height: 300 },
      terms: { top: 300, height: 300 },
    };
    for (const doc of docs) {
      if (doc.id === omit) continue;
      const section = document.createElement('div');
      section.setAttribute('data-consent-section', doc.id);
      Object.defineProperty(section, 'offsetTop', {
        value: offsets[doc.id]!.top,
        configurable: true,
      });
      Object.defineProperty(section, 'offsetHeight', {
        value: offsets[doc.id]!.height,
        configurable: true,
      });
      el.appendChild(section);
    }
  }

  function makeReader() {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true, configurable: true });
    setSections(el);
    return el;
  }

  it('keeps a document read even after its section transiently disappears from a later measurement', () => {
    const el = makeReader();
    const ref: RefObject<HTMLElement | null> = { current: el };
    const { result } = renderHook(() => useReadProgress(ref, docs));

    // 1. Scroll far enough that 'privacy' is read.
    (el as unknown as { scrollTop: number }).scrollTop = 100;
    fireEvent.scroll(el);
    expect(result.current.readIds).toContain('privacy');

    // 2. Simulate a remount/conditional render: privacy's DOM node briefly
    // vanishes from the reader while terms remains, at the same scroll spot.
    setSections(el, 'privacy');
    fireEvent.scroll(el);

    // 3. The node returns, but the reader has scrolled back to the very top
    // — a position that on its own would not qualify privacy as read.
    setSections(el);
    (el as unknown as { scrollTop: number }).scrollTop = 0;
    fireEvent.scroll(el);

    expect(result.current.readIds).toContain('privacy');
  });
});
