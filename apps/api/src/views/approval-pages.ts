/**
 * Server-rendered HTML pages for the admin approval flow.
 *
 * Plain inlined HTML — no template engine, no client-side framework. Styles
 * mirror the Blue Dots portal palette so the admin's confirmation flow feels
 * like part of the same product even though it is served by the Fastify API.
 */

const BRAND_PRIMARY = '#4f46e5';
const BRAND_PRIMARY_DARK = '#4338ca';
const BRAND_PRIMARY_50 = '#eef2ff';
const BRAND_PRIMARY_100 = '#e0e7ff';
const INK_900 = '#0b1020';
const INK_500 = '#475069';
const INK_300 = '#a3a8bd';
const BORDER = '#e5e7eb';
const SURFACE = '#fbfcfe';
const SURFACE_SOFT = '#f7f8fb';
const DANGER = '#b91c1c';
const DANGER_BG = '#fef2f2';
const DANGER_BORDER = '#fecaca';
const SUCCESS = '#15803d';
const SUCCESS_BG = '#dcfce7';
const INFO = '#1e40af';
const INFO_BG = '#dbeafe';

interface ShellOptions {
  title: string;
}

function shell(opts: ShellOptions, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escape(opts.title)} · Blue Dots</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root { color-scheme: light; }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.55;
    background: ${SURFACE};
    color: ${INK_900};
    min-height: 100vh;
    background-image:
      radial-gradient(ellipse 60% 40% at 50% 0%, ${BRAND_PRIMARY_50} 0%, transparent 70%),
      radial-gradient(rgba(79, 70, 229, 0.06) 1px, transparent 1px);
    background-size: 100% 100%, 22px 22px;
  }
  .wrap { max-width: 600px; margin: 0 auto; padding: 48px 20px 64px; }
  .brand {
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 32px;
  }
  .brand-mark {
    width: 44px; height: 44px; border-radius: 12px;
    background: ${BRAND_PRIMARY};
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 17px;
    letter-spacing: -0.02em;
    box-shadow: 0 8px 22px rgba(79, 70, 229, 0.28);
  }
  .brand-text { line-height: 1.2; }
  .brand-name {
    font-weight: 700; font-size: 16px; letter-spacing: -0.01em;
    color: ${INK_900};
  }
  .brand-tag { font-size: 12px; color: ${INK_500}; margin-top: 2px; }
  .card {
    background: #fff;
    border-radius: 18px;
    box-shadow: 0 6px 28px rgba(11, 16, 32, 0.06), 0 1px 0 rgba(11, 16, 32, 0.02);
    overflow: hidden;
    border: 1px solid ${BORDER};
  }
  .card-header {
    padding: 28px 32px 12px;
  }
  .card-body { padding: 4px 32px 28px; }
  .card-footer {
    padding: 22px 32px;
    background: ${SURFACE_SOFT};
    border-top: 1px solid ${BORDER};
    display: flex; align-items: center; gap: 12px; justify-content: flex-end;
    flex-wrap: wrap;
  }
  h1 {
    margin: 0 0 10px;
    font-size: 24px; font-weight: 700;
    letter-spacing: -0.02em;
    color: ${INK_900};
  }
  .lead { margin: 0; color: ${INK_500}; font-size: 14.5px; }
  .meta {
    margin: 22px 0 4px;
    background: ${SURFACE_SOFT};
    border: 1px solid ${BORDER};
    border-radius: 14px;
    padding: 18px 22px;
  }
  .meta-row { display: grid; grid-template-columns: 110px 1fr; gap: 14px; padding: 7px 0; }
  .meta-row + .meta-row { border-top: 1px dashed ${BORDER}; }
  .meta-label { font-size: 12px; font-weight: 600; color: ${INK_500}; text-transform: uppercase; letter-spacing: 0.06em; padding-top: 1px; }
  .meta-value { font-size: 14px; color: ${INK_900}; word-break: break-word; }
  .mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: ${INK_500}; }
  textarea {
    width: 100%; box-sizing: border-box;
    min-height: 100px; padding: 12px 14px;
    border: 1px solid ${BORDER}; border-radius: 12px;
    font: inherit; color: ${INK_900};
    resize: vertical;
    background: #fff;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  textarea:focus { outline: none; border-color: ${BRAND_PRIMARY}; box-shadow: 0 0 0 4px ${BRAND_PRIMARY_100}; }
  label { display: block; font-size: 12px; font-weight: 600; color: ${INK_500}; text-transform: uppercase; letter-spacing: 0.06em; margin: 18px 0 8px; }
  button {
    font: inherit; cursor: pointer;
    padding: 11px 20px; border-radius: 11px; border: 0;
    font-weight: 600; font-size: 14px;
    transition: transform 0.04s ease, box-shadow 0.15s ease, background 0.15s ease;
  }
  button:active { transform: translateY(1px); }
  .btn-primary {
    background: ${BRAND_PRIMARY}; color: #fff;
    box-shadow: 0 8px 18px rgba(79, 70, 229, 0.28);
  }
  .btn-primary:hover { background: ${BRAND_PRIMARY_DARK}; }
  .btn-danger {
    background: ${DANGER}; color: #fff;
    box-shadow: 0 8px 18px rgba(185, 28, 28, 0.22);
  }
  .btn-danger:hover { background: #991b1b; }
  .btn-secondary {
    background: #fff; color: ${INK_900}; border: 1px solid ${BORDER};
  }
  .btn-secondary:hover { background: ${SURFACE_SOFT}; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 600;
    letter-spacing: 0.01em;
  }
  .pill-success { background: ${SUCCESS_BG}; color: ${SUCCESS}; }
  .pill-error { background: ${DANGER_BG}; color: ${DANGER}; border: 1px solid ${DANGER_BORDER}; }
  .pill-info { background: ${INFO_BG}; color: ${INFO}; }
  .accent-bar { height: 4px; }
  .accent-primary { background: linear-gradient(90deg, ${BRAND_PRIMARY}, ${BRAND_PRIMARY_DARK}); }
  .accent-danger { background: linear-gradient(90deg, ${DANGER}, #7f1d1d); }
  .accent-success { background: linear-gradient(90deg, ${SUCCESS}, #166534); }
  .accent-info { background: linear-gradient(90deg, ${INFO}, #1e3a8a); }
  .footer-note { margin: 22px 4px 0; font-size: 12px; color: ${INK_300}; line-height: 1.55; }
  .icon-circle {
    width: 64px; height: 64px; border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center;
    margin: 0 0 18px;
  }
  .icon-circle svg { width: 30px; height: 30px; }
  .icon-success { background: ${SUCCESS_BG}; color: ${SUCCESS}; box-shadow: 0 0 0 8px rgba(21, 128, 61, 0.08); }
  .icon-error { background: ${DANGER_BG}; color: ${DANGER}; box-shadow: 0 0 0 8px rgba(185, 28, 28, 0.08); }
  .icon-info { background: ${INFO_BG}; color: ${INFO}; box-shadow: 0 0 0 8px rgba(30, 64, 175, 0.08); }
  .result-card { text-align: center; }
  .result-card h1 { font-size: 26px; margin-top: 4px; }
  .result-card .lead { max-width: 420px; margin: 8px auto 0; }
  .result-cta {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 20px; border-radius: 11px;
    background: ${BRAND_PRIMARY}; color: #fff;
    text-decoration: none; font-weight: 600; font-size: 14px;
    box-shadow: 0 8px 18px rgba(79, 70, 229, 0.28);
    transition: background 0.15s ease;
  }
  .result-cta:hover { background: ${BRAND_PRIMARY_DARK}; }
  .result-cta-row { margin: 24px 0 4px; display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; }
  .result-secondary {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 11px 18px; border-radius: 11px;
    color: ${INK_500}; text-decoration: none; font-weight: 500; font-size: 14px;
    border: 1px solid ${BORDER}; background: #fff;
  }
  .result-secondary:hover { background: ${SURFACE_SOFT}; color: ${INK_900}; }
  .result-divider {
    display: block; margin: 22px auto 18px;
    width: 64px; height: 1px; background: ${BORDER};
  }
  .result-meta { font-size: 12px; color: ${INK_300}; margin-top: 4px; }
</style></head>
<body>
  <div class="wrap">
    <div class="brand">
      <div class="brand-mark">B</div>
      <div class="brand-text">
        <div class="brand-name">Blue Dots</div>
        <div class="brand-tag">Aggregator Portal · Admin review</div>
      </div>
    </div>
    ${body}
  </div>
</body></html>`;
}

export interface ConfirmPageVars {
  aggregatorId: string;
  intent: 'approve' | 'reject';
  token: string;
  applicantEmail: string;
  association: string;
  aggregatorType: string;
  postUrl: string;
}

export function renderConfirmPage(v: ConfirmPageVars): string {
  const isApprove = v.intent === 'approve';
  const verb = isApprove ? 'Approve' : 'Reject';
  const accentClass = isApprove ? 'accent-primary' : 'accent-danger';
  const submitClass = isApprove ? 'btn-primary' : 'btn-danger';
  const pillClass = isApprove ? 'pill-info' : 'pill-error';
  const pillText = isApprove ? 'Pending approval' : 'Pending rejection';
  const description = isApprove
    ? 'Confirm to enable this aggregator account. The applicant receives a welcome email with sign-in instructions.'
    : 'Confirm to decline this application. The applicant receives a courteous notification with the reason you provide below.';

  const reasonField = !isApprove
    ? `<label for="reason-input">Reason (sent to the applicant)</label>
       <textarea id="reason-input" name="reason" placeholder="A brief explanation helps the applicant understand the decision."></textarea>`
    : '';

  const body = `
    <div class="card">
      <div class="accent-bar ${accentClass}"></div>
      <div class="card-header">
        <span class="pill ${pillClass}">${escape(pillText)}</span>
        <h1 style="margin-top:14px;">${escape(verb)} aggregator application</h1>
        <p class="lead">${escape(description)}</p>
      </div>
      <div class="card-body">
        <div class="meta">
          <div class="meta-row">
            <div class="meta-label">Email</div>
            <div class="meta-value">${escape(v.applicantEmail)}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Slug</div>
            <div class="meta-value mono">${escape(v.association)}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Type</div>
            <div class="meta-value" style="text-transform:capitalize;">${escape(v.aggregatorType)}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Reference</div>
            <div class="meta-value mono">${escape(v.aggregatorId)}</div>
          </div>
        </div>
        <form method="POST" action="${escape(v.postUrl)}">
          <input type="hidden" name="token" value="${escape(v.token)}" />
          <input type="hidden" name="decision" value="${escape(v.intent)}" />
          ${reasonField}
        </form>
      </div>
      <div class="card-footer">
        <form method="POST" action="${escape(v.postUrl)}" style="margin:0;display:inline;">
          <input type="hidden" name="token" value="${escape(v.token)}" />
          <input type="hidden" name="decision" value="${escape(v.intent)}" />
          ${!isApprove ? `<input type="hidden" name="reason" id="reason-mirror" />` : ''}
          <button type="submit" class="${submitClass}">${escape(verb)}</button>
        </form>
      </div>
    </div>
    <p class="footer-note">
      This decision is final once submitted. Approval links are single-use and expire after one hour.
    </p>
    ${
      !isApprove
        ? `<script>
             // Mirror the textarea value into the actual submitting form so the
             // visible textarea inside the card body reaches the server.
             document.querySelector('form[action$="decision"]').addEventListener('submit', function (e) {
               var ta = document.getElementById('reason-input');
               var mirror = document.getElementById('reason-mirror');
               if (ta && mirror) mirror.value = ta.value;
             });
           </script>`
        : ''
    }
  `;
  return shell({ title: `${verb} aggregator` }, body);
}

export interface ResultPageVars {
  status: 'success' | 'error' | 'info';
  title: string;
  message: string;
}

export function renderResultPage(v: ResultPageVars): string {
  const accent =
    v.status === 'success'
      ? 'accent-success'
      : v.status === 'error'
        ? 'accent-danger'
        : 'accent-info';
  const iconClass =
    v.status === 'success' ? 'icon-success' : v.status === 'error' ? 'icon-error' : 'icon-info';
  const iconSvg = resultIconSvg(v.status);
  const portalUrl = process.env.PUBLIC_PORTAL_URL ?? 'http://localhost:3000';
  const decidedAt = new Date().toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const body = `
    <div class="card result-card">
      <div class="accent-bar ${accent}"></div>
      <div class="card-header">
        <span class="icon-circle ${iconClass}">${iconSvg}</span>
        <h1>${escape(v.title)}</h1>
        <p class="lead">${escape(v.message)}</p>
        <span class="result-divider"></span>
        <div class="result-cta-row">
          <a class="result-cta" href="${escape(portalUrl)}">
            Open Blue Dots Portal
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 5l7 7-7 7"/></svg>
          </a>
        </div>
        <div class="result-meta">${escape(decidedAt)}</div>
      </div>
    </div>
    <p class="footer-note" style="text-align:center;">You can safely close this tab.</p>
  `;
  return shell({ title: v.title }, body);
}

function resultIconSvg(status: 'success' | 'error' | 'info'): string {
  if (status === 'success') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
  }
  if (status === 'error') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.51"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="7.5" x2="12" y2="7.51"/></svg>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
