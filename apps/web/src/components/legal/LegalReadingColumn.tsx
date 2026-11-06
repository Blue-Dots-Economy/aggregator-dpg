/**
 * The reading column on the public legal page: each audience's heading,
 * then its documents in `DOC_ORDER`, each with its version line, preamble
 * and sections.
 */

import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';
import { MarkdownContent } from '@/components/forms/MarkdownContent';
import { DOC_ORDER, type DocEntry, type LaidOutDoc, type LaidOutGroup } from './legal-layout';

/**
 * Formats the localized "Version N · Effective DATE" line for a document.
 *
 * Shows "Version N" only when there is no `effective_from`.
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

/** One document: its title, version line, preamble and sections. */
function LegalDocument({ doc, isFirstDoc }: Readonly<{ doc: LaidOutDoc; isFirstDoc: boolean }>) {
  const t = useTranslations('legal');
  const locale = useLocale();
  return (
    // A divider and space before every document but the first.
    <div className={cn('scroll-mt-20', !isFirstDoc && 'mt-10 border-t border-(--bd-border) pt-8')}>
      {/* Document title from the `title` field. The markdown's own title
          heading is stripped. */}
      <h3 id={doc.headingId} className="mt-2 mb-1 scroll-mt-20 text-xl font-bold text-ink-900">
        {doc.entry.title}
      </h3>
      <p className="mb-4 text-xs text-ink-500">{formatVersionLabel(doc.entry, t, locale)}</p>

      {doc.preamble && <MarkdownContent content={doc.preamble} />}

      {doc.sections.map((section) =>
        section.level === 2 ? (
          <div key={section.id}>
            <h2 id={section.id} className="mt-8 mb-2 scroll-mt-20 text-lg font-bold text-ink-900">
              {section.heading}
            </h2>
            {section.body && <MarkdownContent content={section.body} />}
          </div>
        ) : (
          <div key={section.id}>
            <h3
              id={section.id}
              className="mt-6 mb-2 scroll-mt-20 text-base font-semibold text-ink-900"
            >
              {section.heading}
            </h3>
            {section.body && <MarkdownContent content={section.body} />}
          </div>
        ),
      )}
    </div>
  );
}

/** Every audience and its documents, in render order. */
export function LegalReadingColumn({ layout }: Readonly<{ layout: readonly LaidOutGroup[] }>) {
  return (
    <div className="min-w-0 max-w-[72ch]">
      {layout.map((group) => {
        return (
          <section
            key={group.audience}
            aria-labelledby={group.headingId}
            className="mt-10 border-t border-(--bd-border) pt-8 first:mt-6 first:border-t-0 first:pt-0"
          >
            {/* Audience heading marks where each audience starts. */}
            <h2 id={group.headingId} className="mb-6 scroll-mt-20 text-2xl font-bold text-ink-900">
              {group.label}
            </h2>

            {DOC_ORDER.map((d) => (
              <LegalDocument key={d} doc={group.docs[d]} isFirstDoc={d === DOC_ORDER[0]} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
