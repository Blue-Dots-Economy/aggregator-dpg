/**
 * Pulls the section list out of a consent document's Markdown so the public
 * legal page can build a contents rail and anchor each heading.
 *
 * @module apps/web/src/components/legal/legal-sections
 */

/** One entry in the contents rail. */
export interface LegalSection {
  id: string;
  heading: string;
  level: 2 | 3;
}

/**
 * Converts a heading to a URL-safe anchor id.
 *
 * @param heading - Raw heading text.
 * @returns Lowercase hyphenated slug.
 */
function slugify(heading: string): string {
  // Split on separator runs and drop the empties rather than collapsing to
  // hyphens and trimming afterwards: leading/trailing hyphens become
  // structurally impossible instead of removed by a second pass. That second
  // pass was `/^-+|-+$/g`, whose `-+$` is retried at every start position
  // (super-linear); it was safe only because the collapse above guaranteed no
  // run of hyphens could reach it — an invariant a reordering would break
  // silently.
  return heading
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
}

/**
 * Extracts `##` and `###` headings in document order.
 *
 * Fenced code blocks are skipped so a `#` inside an example is not mistaken
 * for a heading. Colliding slugs get a numeric suffix — the dedup is scoped
 * to a single call (a fresh `seen` map per invocation), so it guards against
 * one document repeating a heading (e.g. two "FAQ" subsections); it says
 * nothing about collisions across two different documents, which this
 * function never sees at the same time anyway.
 *
 * @param markdown - The document body.
 * @returns Sections in order; empty when the document has no headings.
 */
export function extractSections(markdown: string): LegalSection[] {
  const out: LegalSection[] = [];
  const seen = new Map<string, number>();
  let inFence = false;

  for (const line of markdown.split('\n')) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // `/^(#{2,3})\s/` + slice, not `/^(#{2,3})\s+(.*)$/`: in the latter, `\s`
    // and `.` both match a space, so the split between `\s+` and `(.*)` is
    // ambiguous and backtracks super-linearly on a failing match. Matching a
    // single delimiter and slicing the remainder is unambiguous whatever the
    // input, rather than relying on this caller passing a trimmed,
    // newline-free line. Behaviour is identical: `####` and `##Title` still
    // fail to match, and the heading is still trimmed.
    const trimmed = line.trim();
    const match = /^(#{2,3})\s/.exec(trimmed);
    if (!match) continue;

    const heading = trimmed.slice(match[1]!.length).trim();
    const base = slugify(heading);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);

    out.push({
      id: count === 1 ? base : `${base}-${count}`,
      heading,
      level: match[1]!.length === 2 ? 2 : 3,
    });
  }
  return out;
}
