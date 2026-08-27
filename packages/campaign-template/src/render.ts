/**
 * Campaign email rendering — Markdown → sanitised HTML + text (aggregator-dpg#578).
 *
 * Renders the shared Markdown body to sanitised HTML and a plain-text part, and
 * substitutes one recipient's placeholder values. Values are HTML-escaped in the
 * HTML part so a decrypted value can never break out of the markup; the subject
 * and text parts are plain text. Isolated in its own subpath so callers that
 * only validate placeholders (the API) never load the Markdown dependencies.
 * Belongs to `@aggregator-dpg/campaign-template`.
 */
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { substitute, escapeHtml, type PlaceholderValues } from './index.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// Allow only the formatting tags a campaign email needs; strip scripts, styles,
// event handlers, and unsafe URL schemes. Links open safely.
const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'u',
    'ul',
    'ol',
    'li',
    'a',
    'h1',
    'h2',
    'h3',
    'h4',
    'blockquote',
    'code',
    'pre',
    'hr',
    'span',
  ],
  allowedAttributes: { a: ['href', 'title'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
  },
};

/**
 * Renders one recipient's email from the shared Markdown template.
 *
 * The Markdown body is rendered to HTML and sanitised (with placeholder tokens
 * still intact), then placeholders are substituted — HTML-escaped in the HTML
 * part, verbatim in the plain-text part. The subject is treated as plain text.
 *
 * @param input.subject - Subject template (may contain placeholders).
 * @param input.bodyMarkdown - Markdown body template (may contain placeholders).
 * @param input.values - This recipient's placeholder values.
 * @returns The rendered subject, HTML, and plain-text parts.
 */
export function renderEmail(input: {
  subject: string;
  bodyMarkdown: string;
  values: PlaceholderValues;
}): RenderedEmail {
  const { subject, bodyMarkdown, values } = input;
  const rendered = marked.parse(bodyMarkdown, { async: false }) as string;
  const htmlTemplate = sanitizeHtml(rendered, SANITIZE_OPTS);
  return {
    subject: substitute(subject, values),
    html: substitute(htmlTemplate, values, escapeHtml),
    text: substitute(bodyMarkdown, values),
  };
}
