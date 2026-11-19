/**
 * Load plan of the QR links loader, in `@aggregator-dpg/api`.
 *
 * Checks each links-sheet row against the coordinator, the network config and
 * the coordinator's existing links. `check` reports every problem it returns;
 * `apply` creates the planned links only when there is none. Reads only.
 */

import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { logger } from '../logger.js';
import { getNetworkConfig } from '../services/network-config.js';
import {
  buildPublicUrl,
  checkVoiceBotChoice,
  LinkSlugSchema,
  resolveMode,
} from '../services/registration-links/create.js';
import { getRegistrationLinksStore } from '../services/registration-links-store/index.js';
import type { RegistrationLink } from '../services/registration-links-store/index.js';
import { getUserStore } from '../services/user-store/index.js';
import type { Coordinator } from '../services/user-store/interface.js';
import { servedDomains } from '../services/user-store/serves.js';
import { twoOptionModeKey } from '../services/voice-bots/index.js';
import { CallTimeout, withTimeout } from './call-timeout.js';
import { LINK_INPUT_PROBLEM, type InputProblem, type LinkRow } from './qr-links-input.js';

/** Problem codes the plan adds to the parser's {@link LINK_INPUT_PROBLEM} codes. */
export const QR_PLAN_PROBLEM = {
  UNKNOWN_COORDINATOR: 'UNKNOWN_COORDINATOR',
  COORDINATOR_NOT_ACTIVE: 'COORDINATOR_NOT_ACTIVE',
  NO_SIGNALS_ORG: 'NO_SIGNALS_ORG',
  DOMAIN_NOT_SERVED: 'DOMAIN_NOT_SERVED',
  UNKNOWN_VOICE_BOT: 'UNKNOWN_VOICE_BOT',
  VOICE_BOT_NOT_FOR_DOMAIN: 'VOICE_BOT_NOT_FOR_DOMAIN',
  VOICE_BOT_REQUIRED: 'VOICE_BOT_REQUIRED',
  INVALID_LINK_NAME: 'INVALID_LINK_NAME',
  /** The coordinator already has a link with this slug that does not cover the row (another status, type or mode, or expired). */
  LINK_NAME_TAKEN: 'LINK_NAME_TAKEN',
  INVALID_EXPIRY: 'INVALID_EXPIRY',
  EXPIRY_IN_PAST: 'EXPIRY_IN_PAST',
  /** An earlier row has the same coordinator and `link_name`, or, with no `link_name`, the same coordinator and profile type. */
  DUPLICATE_ROW: 'DUPLICATE_ROW',
  /** The network declares no two-option mode, or this deployment does not enable it. */
  MODE_NOT_ENABLED: 'MODE_NOT_ENABLED',
  /** A lookup failed or a check threw, so the row could not be checked. */
  CHECK_FAILED: 'CHECK_FAILED',
} as const;

/** One of the {@link QR_PLAN_PROBLEM} codes. */
export type QrPlanProblemCode = (typeof QR_PLAN_PROBLEM)[keyof typeof QR_PLAN_PROBLEM];

/** A link to create, or one already loaded (`existing`). */
export interface PlannedLink {
  row: LinkRow;
  /** The coordinator's `users.id`; the link belongs to it and it is `created_by`. */
  userId: string;
  /** The coordinator's org slug, used in the public URL. */
  orgSlug: string;
  domain: string;
  /** The instance's two-option mode key, checked against the declared and enabled modes. */
  registrationMode: string;
  /** The bot to store: the row's choice, else the domain's default or only bot; `null` when none serves it. */
  voiceBotKey: string | null;
  /** The row's `link_name`; `undefined` gets a random slug. */
  slug: string | undefined;
  /** End of the `expires_on` day in UTC, or `null` for no expiry. */
  expiresAt: Date | null;
  /** A live two-option link that already covers this row; apply creates nothing for it. */
  existing: { slug: string; url: string; voiceBotKey: string | null } | null;
}

/** Links read per `list` call when looking for existing links. */
const LIST_PAGE_SIZE = 100;

/** `expires_on` format. */
const EXPIRY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Row lookups shared across rows, so each coordinator is read once. */
interface PlanCache {
  coordinators: Map<string, Coordinator | null>;
  /** Every link of a coordinator, in all statuses: slugs are unique per coordinator across them. */
  links: Map<string, RegistrationLink[]>;
}

/** Bounds a store lookup by the per-call timeout, when one is set. */
type Bound = <T>(promise: Promise<T>, what: string) => Promise<T>;

/** Unwraps a store result, throwing so the row is reported as CHECK_FAILED. */
function must<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
  operation: string,
): T {
  if (!result.ok) {
    throw new UpstreamError(`qr-links plan lookup failed: ${operation}`, {
      code: 'PLAN_LOOKUP_FAILED',
      details: { operation, reason: result.error.code },
    });
  }
  return result.value;
}

/**
 * Reads `expires_on` as the end of that day in UTC.
 *
 * @returns The instant, or `null` when the value is not a real `YYYY-MM-DD` date.
 */
function parseExpiry(value: string): Date | null {
  const m = EXPIRY_PATTERN.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d, 23, 59, 59, 999));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) {
    return null;
  }
  return at;
}

async function findCoordinator(
  email: string,
  cache: PlanCache,
  bound: Bound,
): Promise<Coordinator | null> {
  const cached = cache.coordinators.get(email);
  if (cached !== undefined) return cached;
  const found = must(
    await bound(getUserStore().findByContactEmail(email), 'coordinator lookup'),
    'userStore.findByContactEmail',
  );
  cache.coordinators.set(email, found);
  return found;
}

/** The coordinator's links in every status, every page. */
async function linksOf(
  userId: string,
  cache: PlanCache,
  bound: Bound,
): Promise<RegistrationLink[]> {
  const cached = cache.links.get(userId);
  if (cached) return cached;
  const store = getRegistrationLinksStore();
  const rows: RegistrationLink[] = [];
  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const page = must(
      await bound(store.list(userId, { limit: LIST_PAGE_SIZE, offset }), 'links list'),
      'registrationLinksStore.list',
    );
    rows.push(...page.rows);
    if (page.rows.length === 0 || rows.length >= page.total) break;
  }
  cache.links.set(userId, rows);
  return rows;
}

/** The code logged for a failed row check: the lookup's code, or CALL_TIMEOUT. */
function rowErrorCode(err: unknown): string | undefined {
  if (err instanceof UpstreamError) return err.code;
  return err instanceof CallTimeout ? 'CALL_TIMEOUT' : undefined;
}

/** Maps a voice-bot refusal of the shared create rules to a plan problem. */
function voiceBotProblem(
  code: string,
  requested: string,
  cfg: ResolvedNetworkConfig,
): QrPlanProblemCode {
  if (code === 'VOICE_BOT_REQUIRED') return QR_PLAN_PROBLEM.VOICE_BOT_REQUIRED;
  if (code === 'INVALID_VOICE_BOT') {
    return cfg.aggregator.voice_bots.some((b) => b.key === requested)
      ? QR_PLAN_PROBLEM.VOICE_BOT_NOT_FOR_DOMAIN
      : QR_PLAN_PROBLEM.UNKNOWN_VOICE_BOT;
  }
  return QR_PLAN_PROBLEM.CHECK_FAILED;
}

type AddProblem = (code: QrPlanProblemCode, field?: string) => void;

/** Checks the row's own link name and expiry; returns the parsed expiry. */
function checkRowInput(row: LinkRow, now: Date, add: AddProblem): Date | null {
  if (row.linkName !== '' && !LinkSlugSchema.safeParse(row.linkName).success) {
    add(QR_PLAN_PROBLEM.INVALID_LINK_NAME, 'link_name');
  }
  if (row.expiresOn === '') return null;
  const expiresAt = parseExpiry(row.expiresOn);
  const expiryProblem = expiryCode(expiresAt, now);
  if (expiryProblem) add(expiryProblem, 'expires_on');
  return expiresAt;
}

/** Flags a coordinator who is not active or has no Signals org. */
function checkCoordinator(coordinator: Coordinator, add: AddProblem): void {
  if (coordinator.status !== 'active') {
    add(QR_PLAN_PROBLEM.COORDINATOR_NOT_ACTIVE, 'coordinator_email');
  }
  if (coordinator.signalstackOrgId === null || coordinator.orgSlug === '') {
    add(QR_PLAN_PROBLEM.NO_SIGNALS_ORG, 'coordinator_email');
  }
}

/** The DUPLICATE_ROW problem when an earlier row has this row's key; otherwise records the key. */
function duplicateProblem(row: LinkRow, email: string, seen: Set<string>): InputProblem | null {
  // A link name is one slug per coordinator, whatever the profile type.
  const named = row.linkName !== '';
  const key = JSON.stringify(
    named ? ['name', email, row.linkName] : ['type', email, row.profileType],
  );
  if (!seen.has(key)) {
    seen.add(key);
    return null;
  }
  return named
    ? { line: row.line, code: QR_PLAN_PROBLEM.DUPLICATE_ROW, field: 'link_name' }
    : { line: row.line, code: QR_PLAN_PROBLEM.DUPLICATE_ROW };
}

/** Logs a failed row check without its contents. */
function logRowFailure(row: LinkRow, err: unknown): void {
  logger.error(
    {
      operation: 'qrLinks.buildLinksPlan.check',
      status: 'failure',
      line: row.line,
      error_type: err instanceof Error ? err.constructor.name : typeof err,
      error_code: rowErrorCode(err),
      reason: err instanceof UpstreamError ? err.details?.['reason'] : undefined,
    },
    'qr-links row check failed',
  );
}

/** The problem with a row's parsed expiry, if any. */
function expiryCode(expiresAt: Date | null, now: Date): QrPlanProblemCode | null {
  if (expiresAt === null) return QR_PLAN_PROBLEM.INVALID_EXPIRY;
  return expiresAt.getTime() <= now.getTime() ? QR_PLAN_PROBLEM.EXPIRY_IN_PAST : null;
}

/** The `link_name`s each coordinator's rows give, by lower-cased email; blocked rows are skipped. */
function claimedNames(rows: LinkRow[], blocked: ReadonlySet<number>): Map<string, Set<string>> {
  const claimedBy = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.linkName === '' || blocked.has(row.line)) continue;
    const email = row.coordinatorEmail.trim().toLowerCase();
    const names = claimedBy.get(email) ?? new Set<string>();
    names.add(row.linkName);
    claimedBy.set(email, names);
  }
  return claimedBy;
}

/**
 * Checks one row.
 *
 * @returns The planned link (when `modeKey` is set and the row has no problem) and the row's problems.
 * @throws {UpstreamError} When a lookup fails.
 */
async function planRow(
  row: LinkRow,
  email: string,
  modeKey: string | null,
  ctx: {
    cfg: ResolvedNetworkConfig;
    now: Date;
    cache: PlanCache;
    bound: Bound;
    /** `link_name`s other rows of this sheet give for the same coordinator. */
    claimed: ReadonlySet<string>;
  },
): Promise<{ link: PlannedLink | null; problems: InputProblem[] }> {
  const problems: InputProblem[] = [];
  const add = (code: QrPlanProblemCode, field?: string): void => {
    problems.push(field === undefined ? { line: row.line, code } : { line: row.line, code, field });
  };

  const expiresAt = checkRowInput(row, ctx.now, add);

  const coordinator = await findCoordinator(email, ctx.cache, ctx.bound);
  if (!coordinator) {
    add(QR_PLAN_PROBLEM.UNKNOWN_COORDINATOR, 'coordinator_email');
    return { link: null, problems };
  }
  checkCoordinator(coordinator, add);
  const domain = row.profileType;
  if (!servedDomains(coordinator.serves, ctx.cfg.domainIds).includes(domain)) {
    add(QR_PLAN_PROBLEM.DOMAIN_NOT_SERVED, 'profile_type');
    return { link: null, problems };
  }
  if (modeKey === null) return { link: null, problems };

  const voiceBot = checkVoiceBotChoice(row.voiceBot || undefined, modeKey, domain, ctx.cfg);
  if (!voiceBot.ok) add(voiceBotProblem(voiceBot.error.code, row.voiceBot, ctx.cfg), 'voice_bot');
  if (!voiceBot.ok || problems.length > 0) return { link: null, problems };

  const all = await linksOf(coordinator.id, ctx.cache, ctx.bound);
  const covers = (l: RegistrationLink): boolean =>
    l.status === 'live' &&
    l.registrationMode === modeKey &&
    l.domain === domain &&
    (l.expiresAt === null || l.expiresAt.getTime() > ctx.now.getTime());
  // A link a named row of this sheet claims is that row's, not this one's.
  // A taken slug would get a random suffix on create, and a rerun could not find that link again.
  const match =
    row.linkName === ''
      ? all.find((l) => covers(l) && !ctx.claimed.has(l.slug))
      : all.find((l) => l.slug === row.linkName);
  if (row.linkName !== '' && match && !covers(match)) {
    add(QR_PLAN_PROBLEM.LINK_NAME_TAKEN, 'link_name');
    return { link: null, problems };
  }
  return {
    link: {
      row,
      userId: coordinator.id,
      orgSlug: coordinator.orgSlug,
      domain,
      registrationMode: modeKey,
      voiceBotKey: voiceBot.value,
      slug: row.linkName === '' ? undefined : row.linkName,
      expiresAt,
      existing: match
        ? {
            slug: match.slug,
            url: buildPublicUrl(coordinator.orgSlug, match.slug),
            voiceBotKey: match.voiceBotKey,
          }
        : null,
    },
    problems,
  };
}

/**
 * Builds the load plan for the links sheet.
 *
 * Rows with an input problem are not checked. A missing required column stops
 * all row checks. A failed or timed-out lookup is reported on its row as CHECK_FAILED.
 *
 * @param input - The parsed rows, the parser's problems, the time expiries are compared with
 *   and the per-lookup timeout (none when absent).
 * @returns The planned links and every problem, the input problems first.
 */
export async function buildLinksPlan(input: {
  rows: LinkRow[];
  inputProblems: InputProblem[];
  now?: Date;
  callTimeoutMs?: number;
}): Promise<{ links: PlannedLink[]; problems: InputProblem[] }> {
  const start = Date.now();
  const now = input.now ?? new Date();
  const problems: InputProblem[] = [...input.inputProblems];
  const links: PlannedLink[] = [];
  const cfg = await getNetworkConfig();

  // The same enabled-mode check link creation applies (declared modes and AGGREGATOR_ONBOARDING_ENABLED).
  const modeKey = twoOptionModeKey(cfg, (mode) => resolveMode(mode, cfg).ok);
  if (modeKey === null) {
    problems.push({ line: 1, code: QR_PLAN_PROBLEM.MODE_NOT_ENABLED, field: 'registration_mode' });
  }

  const missingColumn = input.inputProblems.some(
    (p) => p.code === LINK_INPUT_PROBLEM.MISSING_COLUMN,
  );
  const blocked = new Set(input.inputProblems.map((p) => p.line));
  const seen = new Set<string>();
  const cache: PlanCache = { coordinators: new Map(), links: new Map() };
  const { callTimeoutMs } = input;
  const bound: Bound = (promise, what) =>
    callTimeoutMs === undefined ? promise : withTimeout(promise, callTimeoutMs, what);
  const claimedBy = claimedNames(input.rows, blocked);

  for (const row of missingColumn ? [] : input.rows) {
    if (blocked.has(row.line)) continue;
    const email = row.coordinatorEmail.trim().toLowerCase();
    const duplicate = duplicateProblem(row, email, seen);
    if (duplicate) {
      problems.push(duplicate);
      continue;
    }
    try {
      const planned = await planRow(row, email, modeKey, {
        cfg,
        now,
        cache,
        bound,
        claimed: claimedBy.get(email) ?? new Set<string>(),
      });
      problems.push(...planned.problems);
      if (planned.link) links.push(planned.link);
    } catch (err) {
      logRowFailure(row, err);
      problems.push({ line: row.line, code: QR_PLAN_PROBLEM.CHECK_FAILED });
    }
  }

  logger.info({
    operation: 'qrLinks.buildLinksPlan',
    status: problems.length === 0 ? 'success' : 'failure',
    rows: input.rows.length,
    links: links.length,
    existing: links.filter((l) => l.existing !== null).length,
    problems: problems.length,
    latency_ms: Date.now() - start,
  });
  return { links, problems };
}
