/**
 * Shared HTML scaffolding for outbound emails.
 *
 * Email clients strip <style> tags and external CSS — every rule lives
 * inline. Layout is single-column, max 560px, system font stack.
 */

const BRAND_INK = '#0b1020';
const BRAND_INK_500 = '#475069';
const BRAND_BORDER = '#e8eaf1';
const BRAND_BG = '#f7f8fb';

/**
 * Network-driven brand surface for outbound emails. Sourced from
 * `getNetworkConfig().aggregator.brand` at server boot via
 * `setEmailBrand` — keeps each template synchronous + free of an
 * upstream config lookup.
 */
export interface EmailBrand {
  short_name: string;
  long_name: string;
  primary_color: string;
}

const DEFAULT_BRAND: EmailBrand = {
  short_name: 'Aggregator',
  long_name: 'Aggregator Portal',
  primary_color: '#4f46e5',
};

let runtimeBrand: EmailBrand | null = null;

/** Called once from the server boot path after network config resolves. */
export function setEmailBrand(brand: EmailBrand): void {
  runtimeBrand = brand;
}

/** Returns the active brand (or the generic default while unconfigured). */
export function getEmailBrand(): EmailBrand {
  return runtimeBrand ?? DEFAULT_BRAND;
}

export interface ShellOptions {
  preheader?: string;
  bodyHtml: string;
}

/**
 * Wraps a body fragment in the shared email shell (header bar + footer).
 *
 * @param opts - Preheader + the inner body HTML.
 * @returns Full HTML document ready to send.
 */
export function renderShell(opts: ShellOptions): string {
  const preheader = opts.preheader ?? '';
  const brand = getEmailBrand();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(brand.short_name)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND_INK};">
<span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND_BG};padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid ${BRAND_BORDER};border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:24px 28px;border-bottom:1px solid ${BRAND_BORDER};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;">
                  <div style="font-weight:700;font-size:18px;letter-spacing:-0.01em;color:${BRAND_INK};">${escapeHtml(brand.short_name)}</div>
                  <div style="font-size:12px;color:${BRAND_INK_500};margin-top:2px;">${escapeHtml(brand.long_name)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:28px;">
            ${opts.bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:18px 28px;border-top:1px solid ${BRAND_BORDER};font-size:12px;color:${BRAND_INK_500};">
            Sent by ${escapeHtml(brand.long_name)}. If you received this in error, ignore it.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * Renders a primary CTA button.
 */
export function ctaButton(
  label: string,
  href: string,
  color: 'primary' | 'danger' = 'primary',
): string {
  const bg = color === 'danger' ? '#dc2626' : getEmailBrand().primary_color;
  return `<a href="${href}" style="display:inline-block;background:${bg};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px;">${escapeHtml(label)}</a>`;
}

/**
 * Status pill shown above an email heading (e.g. "Action required"). Uses a
 * table cell rather than a styled span: Outlook drops padding on inline
 * elements, which would collapse the pill into plain text.
 *
 * @param label - Short pill text; upper-cased for emphasis by the caller's CSS.
 * @param tone - `info` for neutral notices, `action` for anything needing a reply.
 * @returns HTML for the pill.
 */
export function pill(label: string, tone: 'info' | 'action' = 'info'): string {
  const bg = tone === 'action' ? '#dbeafe' : '#f1f5f9';
  const fg = tone === 'action' ? '#1d4ed8' : '#475069';
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;">` +
    `<tr><td style="background:${bg};color:${fg};border-radius:999px;padding:6px 14px;` +
    `font-size:11.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">` +
    `${escapeHtml(label)}</td></tr></table>`
  );
}

/**
 * Full-width CTA. The inline-block `ctaButton` shrink-wraps its label, which
 * reads as an afterthought when it is the one action the mail exists for.
 *
 * @param label - Button text.
 * @param href - Target URL; already signed/encoded by the caller.
 * @param color - `primary` uses the brand colour, `danger` red.
 * @returns HTML for a full-width button row.
 */
export function ctaButtonFull(
  label: string,
  href: string,
  color: 'primary' | 'danger' = 'primary',
): string {
  const bg = color === 'danger' ? '#dc2626' : getEmailBrand().primary_color;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
    `<tr><td align="center" style="background:${bg};border-radius:12px;">` +
    `<a href="${href}" style="display:block;padding:15px 22px;color:#ffffff;` +
    `text-decoration:none;font-weight:700;font-size:15px;">${escapeHtml(label)} &rarr;</a>` +
    `</td></tr></table>`
  );
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
