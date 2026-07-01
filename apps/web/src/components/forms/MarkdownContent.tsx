'use client';
/**
 * Renders sanitised GFM Markdown content using react-markdown.
 *
 * Does not enable rehype-raw so no raw HTML in the source is executed.
 * Safe for untrusted content coming from config files.
 *
 * @module apps/web/src/components/forms/MarkdownContent
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Props for {@link MarkdownContent}. */
export interface MarkdownContentProps {
  /** GFM Markdown string to render. */
  content: string;
}

/**
 * Renders a GFM Markdown string as sanitised HTML inside a prose container.
 *
 * @param props - The Markdown content string to render.
 * @returns A div containing the rendered Markdown.
 */
export function MarkdownContent({ content }: MarkdownContentProps): JSX.Element {
  return (
    <div className="prose prose-sm max-w-none text-ink-700">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
