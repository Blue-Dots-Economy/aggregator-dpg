/**
 * BFF endpoint for dashboard bulk actions.
 *
 *   POST /api/dashboard/actions
 *   { "action": "trigger_callback", "domain": "seeker", "ids": ["..."] }
 *
 * Stub implementation: validates the request (session, allowlisted action,
 * bounded id list), logs it, and acknowledges with 202. No upstream call is
 * made yet — the contract is fixed here so the UI and future callback
 * service integrate without churn. Extending the action surface means
 * adding the new name to {@link ALLOWED_ACTIONS} and forwarding it
 * upstream once the service exists.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../../lib/server-session';
import { logger } from '../../../../lib/logger';
import { unauthorizedResponse } from '../../../../lib/bff-errors';

export const runtime = 'nodejs';

/** Server-side allowlist of bulk actions the BFF accepts. */
const ALLOWED_ACTIONS = new Set(['trigger_callback']);

/** Upper bound on ids per request — keeps the stub (and future upstream calls) bounded. */
const MAX_IDS = 500;

interface BulkActionBody {
  action: string;
  domain: string;
  ids: string[];
}

/**
 * Validates the request body shape without zod (the web app has no zod
 * dependency). Returns the parsed body or an error message.
 */
function parseBody(raw: unknown): BulkActionBody | string {
  if (typeof raw !== 'object' || raw === null) return 'body must be a JSON object';
  const b = raw as Record<string, unknown>;
  if (typeof b.action !== 'string' || !b.action) return '`action` is required';
  if (!ALLOWED_ACTIONS.has(b.action)) return `unknown action: ${b.action}`;
  if (typeof b.domain !== 'string' || !b.domain) return '`domain` is required';
  if (!Array.isArray(b.ids) || b.ids.length === 0) return '`ids` must be a non-empty array';
  if (b.ids.length > MAX_IDS) return `\`ids\` exceeds the maximum of ${MAX_IDS}`;
  if (!b.ids.every((id) => typeof id === 'string' && id.length > 0)) {
    return '`ids` must contain non-empty strings';
  }
  return { action: b.action, domain: b.domain, ids: b.ids as string[] };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: { message: 'invalid JSON', code: 'BAD_REQUEST' } },
      { status: 400 },
    );
  }

  const parsed = parseBody(raw);
  if (typeof parsed === 'string') {
    return NextResponse.json({ error: { message: parsed, code: 'BAD_REQUEST' } }, { status: 400 });
  }

  // Stub: acknowledge only. Swap this log for the upstream call when the
  // callback service lands. Ids are intentionally NOT logged (PII discipline)
  // — only the count.
  logger.info({
    operation: 'dashboard.bulkAction',
    status: 'skipped',
    action: parsed.action,
    domain: parsed.domain,
    id_count: parsed.ids.length,
  });

  return NextResponse.json({ accepted: parsed.ids.length }, { status: 202 });
}
