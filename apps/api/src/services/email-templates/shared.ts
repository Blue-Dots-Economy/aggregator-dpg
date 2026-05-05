/**
 * Shared HTML scaffolding for outbound emails.
 *
 * Email clients strip <style> tags and external CSS — every rule lives
 * inline. Layout is single-column, max 560px, system font stack.
 */

const BRAND_PRIMARY = '#4f46e5';
const BRAND_INK = '#0b1020';
const BRAND_INK_500 = '#475069';
const BRAND_BORDER = '#e8eaf1';
const BRAND_BG = '#f7f8fb';

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
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blue Dots</title>
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
                  <div style="font-weight:700;font-size:18px;letter-spacing:-0.01em;color:${BRAND_INK};">Blue Dots</div>
                  <div style="font-size:12px;color:${BRAND_INK_500};margin-top:2px;">Aggregator Portal</div>
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
            Sent by Blue Dots Aggregator Portal. If you received this in error, ignore it.
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
  const bg = color === 'danger' ? '#dc2626' : BRAND_PRIMARY;
  return `<a href="${href}" style="display:inline-block;background:${bg};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px;">${escapeHtml(label)}</a>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
