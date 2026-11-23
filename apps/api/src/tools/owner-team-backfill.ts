/**
 * Owner team backfill (`@aggregator-dpg/api`): gives every existing organisation
 * owner their own coordinator account in their organisation, approved, so they
 * can onboard participants without pressing "Add myself to My Team".
 *
 *   node dist/tools/owner-team-backfill.js [--dry-run]
 *
 * The account's consent row is derived from the owner's own organisation
 * consent row: the same document versions and valid-till, with source
 * {@link BACKFILL_CONSENT_SOURCE}. An owner is skipped unless the organisation
 * and team member documents at those versions are word for word the same.
 *
 * Needs the full API environment (database, Signals, network config). Output
 * carries org ids, counts and error codes only. A re-run creates nothing new.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { and, desc, eq } from 'drizzle-orm';
import { consentRecord } from '../db/schema.js';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { logger } from '../logger.js';
import { getDb } from '../db/client.js';
import { getNetworkConfig } from '../services/network-config.js';
import { getOrganisationStore, type Organisation } from '../services/organisation-store/index.js';
import { getUserStore } from '../services/user-store/index.js';
import { PLACEHOLDER_OWNER_EMAIL } from '../services/organisation-root.js';
import { chosenNetworkDomains } from '../services/org-schema-validator.js';
import {
  approveOwnerTeamAccount,
  createOwnerTeamAccount,
  type OwnerTeamAccountInput,
} from '../services/registration/owner-self-add.js';

/** Ledger `source` of a consent row derived from the owner's organisation consent. */
export const BACKFILL_CONSENT_SOURCE = 'owner-team-backfill';

/** Organisations read per page from the store; its search maximum. */
const ORG_PAGE_SIZE = 100;

/** The owner's newest organisation consent row. */
export interface OrgConsentRow {
  termsVersion: number;
  privacyVersion: number;
  acceptedAt: Date;
  validTill: Date | null;
}

/** The owner's coordinator account on their contact, when there is one. */
export interface ExistingTeamAccount {
  id: string;
  orgId: string | null;
  status: string;
}

/** Why an organisation's owner got no new team account. */
export type SkipReason =
  | 'has_team_account'
  | 'no_login'
  | 'no_phone'
  | 'no_org_consent'
  | 'org_consent_expired'
  | 'documents_differ'
  | 'team_account_in_other_org';

/** What {@link ownerTeamBackfillStep} reads and writes (fakes in tests). */
export interface OwnerTeamBackfillDeps {
  /** Every active aggregator organisation. */
  listActiveOrgs: () => Promise<Organisation[]>;
  /** The newest consent row of the organisation, or `null`. */
  orgConsent: (orgId: string) => Promise<OrgConsentRow | null>;
  /** Whether the organisation and team member documents are identical at these versions. */
  documentsMatch: (termsVersion: number, privacyVersion: number) => Promise<boolean>;
  /** The coordinator account on the owner's contact, or `null`. */
  teamAccountOf: (org: Organisation) => Promise<ExistingTeamAccount | null>;
  /** The network's domain ids. */
  domainIds: string[];
  create: (input: OwnerTeamAccountInput) => ReturnType<typeof createOwnerTeamAccount>;
  approve: (org: Organisation) => ReturnType<typeof approveOwnerTeamAccount>;
  now: () => Date;
}

/** Outcome of {@link ownerTeamBackfillStep}, by organisation id. */
export interface OwnerTeamBackfillReport {
  orgs: number;
  /** Organisations whose owner got a new, approved team account (or would, in a dry run). */
  created: string[];
  /** Organisations whose owner's pending team account was approved (or would be). */
  approved: string[];
  skipped: Record<SkipReason, string[]>;
  /** Organisations where a write failed, with the error code. */
  failed: Array<{ orgId: string; code: string }>;
}

/** An empty report for `orgs` organisations. */
function emptyReport(orgs: number): OwnerTeamBackfillReport {
  return {
    orgs,
    created: [],
    approved: [],
    skipped: {
      has_team_account: [],
      no_login: [],
      no_phone: [],
      no_org_consent: [],
      org_consent_expired: [],
      documents_differ: [],
      team_account_in_other_org: [],
    },
    failed: [],
  };
}

/** The profile types an owner's team account serves: the org's chosen domains, else all. */
async function servesOf(org: Organisation, domainIds: string[]): Promise<string[]> {
  const chosen = (await chosenNetworkDomains(org.profile)).filter((d) => domainIds.includes(d));
  return chosen.length > 0 ? chosen : domainIds;
}

/**
 * Gives each eligible organisation owner a team account, earliest
 * organisation first, one account per owner.
 *
 * @param deps - Stores and services, or fakes.
 * @param opts - `dryRun` reads only.
 * @returns What was done, or would be, per organisation.
 */
export async function ownerTeamBackfillStep(
  deps: OwnerTeamBackfillDeps,
  opts: { dryRun: boolean },
): Promise<OwnerTeamBackfillReport> {
  const orgs = (await deps.listActiveOrgs())
    .filter((o) => !o.isDefault && o.ownerEmail !== PLACEHOLDER_OWNER_EMAIL)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const report = emptyReport(orgs.length);
  const handledOwners = new Set<string>();
  for (const org of orgs) {
    // Sequential: each owner's accounts are read after the previous org's writes.
    const outcome = await backfillOne(deps, org, handledOwners, opts); // NOSONAR typescript:S9382
    if (outcome.kind === 'skipped') report.skipped[outcome.reason].push(org.id);
    else if (outcome.kind === 'failed') report.failed.push({ orgId: org.id, code: outcome.code });
    else report[outcome.kind].push(org.id);
  }
  return report;
}

type OneOutcome =
  | { kind: 'created' | 'approved' }
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'failed'; code: string };

/** Decides and, unless a dry run, writes one organisation's owner team account. */
async function backfillOne(
  deps: OwnerTeamBackfillDeps,
  org: Organisation,
  handledOwners: Set<string>,
  opts: { dryRun: boolean },
): Promise<OneOutcome> {
  if (handledOwners.has(org.ownerUserId)) {
    return { kind: 'skipped', reason: 'team_account_in_other_org' };
  }
  const existing = await deps.teamAccountOf(org);
  if (existing) {
    handledOwners.add(org.ownerUserId);
    if (existing.status !== 'pending') return { kind: 'skipped', reason: 'has_team_account' };
    if (existing.orgId !== org.id) {
      return { kind: 'skipped', reason: 'team_account_in_other_org' };
    }
    if (opts.dryRun) return { kind: 'approved' };
    const approved = await deps.approve(org);
    return approved.success ? { kind: 'approved' } : { kind: 'failed', code: approved.error.code };
  }
  if (!org.ownerKcSub) return { kind: 'skipped', reason: 'no_login' };
  if (!org.ownerPhone) return { kind: 'skipped', reason: 'no_phone' };
  const consent = await deps.orgConsent(org.id);
  if (!consent) return { kind: 'skipped', reason: 'no_org_consent' };
  if (!consent.validTill || consent.validTill <= deps.now()) {
    return { kind: 'skipped', reason: 'org_consent_expired' };
  }
  if (!(await deps.documentsMatch(consent.termsVersion, consent.privacyVersion))) {
    return { kind: 'skipped', reason: 'documents_differ' };
  }
  handledOwners.add(org.ownerUserId);
  if (opts.dryRun) return { kind: 'created' };

  const created = await deps.create({
    org,
    subject: org.ownerKcSub,
    serves: await servesOf(org, deps.domainIds),
    consent: {
      value: true,
      given_at: consent.acceptedAt.toISOString(),
      valid_till: consent.validTill.toISOString(),
    },
    derivedConsent: {
      termsVersion: consent.termsVersion,
      privacyVersion: consent.privacyVersion,
      source: BACKFILL_CONSENT_SOURCE,
    },
  });
  if (!created.success) return { kind: 'failed', code: created.error.code };
  const approved = await deps.approve(org);
  return approved.success ? { kind: 'created' } : { kind: 'failed', code: approved.error.code };
}

/** Every active aggregator organisation, paged through the store. */
async function activeOrgs(): Promise<Organisation[]> {
  const store = getOrganisationStore();
  const all: Organisation[] = [];
  let cursor: { name: string; id: string } | undefined;
  for (;;) {
    const page = /* NOSONAR typescript:S9382 */ await store.search({
      orgIds: null,
      status: 'active',
      limit: ORG_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (!page.ok) throw new Error(`org list failed (${page.error.code})`);
    all.push(...page.value.rows);
    if (!page.value.nextCursor) return all;
    cursor = page.value.nextCursor;
  }
}

/** The organisation's newest consent row. */
async function newestOrgConsent(orgId: string): Promise<OrgConsentRow | null> {
  const [row] = await getDb()
    .select({
      termsVersion: consentRecord.termsVersion,
      privacyVersion: consentRecord.privacyVersion,
      acceptedAt: consentRecord.acceptedAt,
      validTill: consentRecord.validTill,
    })
    .from(consentRecord)
    .where(and(eq(consentRecord.subjectType, 'organisation'), eq(consentRecord.orgId, orgId)))
    .orderBy(desc(consentRecord.acceptedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Builds the check that the organisation and team member documents match at
 * given versions, from this deployment's consent config.
 */
export async function documentsMatcher(): Promise<
  (termsVersion: number, privacyVersion: number) => Promise<boolean>
> {
  const { network, brand } = resolveActiveNetwork();
  const cfg = await loadConsentConfig(network, brand);
  const { org, aggregator } = cfg.audiences;
  const same = (doc: 'terms' | 'privacy', version: number): boolean => {
    const a = org.documents[doc].versions.find((v) => v.version === version);
    const b = aggregator.documents[doc].versions.find((v) => v.version === version);
    return a !== undefined && b !== undefined && a.content === b.content;
  };
  return async (termsVersion, privacyVersion) =>
    same('terms', termsVersion) && same('privacy', privacyVersion);
}

/** The coordinator account on the organisation owner's contact. */
async function teamAccountOf(org: Organisation): Promise<ExistingTeamAccount | null> {
  const found = await getUserStore().findByContactEmail(org.ownerEmail);
  if (!found.ok) throw new Error(`user lookup failed (${found.error.code})`);
  const row = found.value;
  return row ? { id: row.id, orgId: row.parentOrgId ?? null, status: row.status } : null;
}

/**
 * Runs the backfill against this deployment and prints the report.
 *
 * @param argv - `--dry-run` reads only.
 * @param out - Line printer.
 * @returns 0, or 1 when any write failed (a re-run resumes).
 */
export async function main(argv: string[], out: (line: string) => void): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const report = await ownerTeamBackfillStep(
    {
      listActiveOrgs: activeOrgs,
      orgConsent: newestOrgConsent,
      documentsMatch: await documentsMatcher(),
      teamAccountOf,
      domainIds: (await getNetworkConfig()).domainIds,
      create: (input) => createOwnerTeamAccount(input, logger),
      approve: (org) => approveOwnerTeamAccount(org, logger),
      now: () => new Date(),
    },
    { dryRun },
  );
  const { created, approved, skipped, failed } = report;
  const counts = {
    orgs: report.orgs,
    created: created.length,
    approved: approved.length,
    skipped: Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, v.length])),
    failed: failed.length,
  };
  out(`owner-team-backfill ${JSON.stringify(counts)}${dryRun ? ' (dry run)' : ''}`);
  for (const id of created) out(`  ${dryRun ? 'would create' : 'created'}: org ${id}`);
  for (const id of approved) out(`  ${dryRun ? 'would approve' : 'approved'}: org ${id}`);
  for (const [reason, ids] of Object.entries(skipped)) {
    for (const id of ids) out(`  skipped (${reason}): org ${id}`);
  }
  for (const f of failed) out(`  failed (${f.code}): org ${f.orgId}`);
  return failed.length > 0 ? 1 : 0;
}

/** Whether this module is the process entry, including through a symlink. */
function isEntry(): boolean {
  try {
    return pathToFileURL(realpathSync(process.argv[1] ?? '')).href === import.meta.url;
  } catch {
    // No path (e.g. `node -e`): not the entry.
    return false;
  }
}

if (isEntry()) {
  try {
    process.exitCode = await main(process.argv.slice(2), (line) => {
      process.stdout.write(`${line}\n`);
    });
  } catch (err) {
    logger.error({
      operation: 'owner_team_backfill',
      status: 'failure',
      error_type: err instanceof Error ? err.name : typeof err,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  }
  process.exit();
}
