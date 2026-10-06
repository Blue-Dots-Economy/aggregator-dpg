/**
 * Boot-time reconcile of the network-facilitator root and the Default org
 * (`@aggregator-dpg/api`, migration 0028; design
 * `docs/plans/organisation-phase-3-implementation.md` §3.2).
 *
 * Migration 0028 seeds the root and the Default org with PLACEHOLDER values
 * (slug `network`, name `Network`, an owner account on
 * `network-admin@nf.invalid`). On every boot this module puts the configured
 * values in place:
 *
 * - root `slug` ← `brand.url_slug`; `name` ← `aggregator.legal_name` →
 *   `aggregator.name`; `legal_name` ← `aggregator.legal_name`;
 * - root owner ← the first `ADMIN_EMAILS` entry;
 * - Default owner ← `DEFAULT_ORG_OWNER_EMAIL`, else the root's owner.
 *
 * Then, best-effort, it mirrors both orgs and their configured owners into the
 * IdP the way org registration does (a group per org; a disabled user per owner
 * unless one already exists). Idempotent; counts-only logs; never throws — a
 * failure is logged and retried on the next boot.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { linkContact, type DbExecutor } from '../db/contact-writes.js';
import {
  IdentityMismatchError,
  IdentityTakenError,
  linkAdminAccount,
  linkIdentity,
} from '../db/account-writes.js';
import { logger } from '../logger.js';
import { pgErrorCode } from '../db/pg-error.js';
import type { IdpAdminAdapter } from './idp-admin/interface.js';
import { IDP_PROVIDER } from './idp-admin/provider.js';
import { KC_ATTR } from './idp-admin/index.js';

/** The placeholder owner address 0028 seeds; never mirrored to the IdP. */
export const PLACEHOLDER_OWNER_EMAIL = 'network-admin@nf.invalid';

/** Configured values for the root and the Default org (absent = keep). */
export interface RootConfig {
  nfSlug: string | null;
  nfName: string | null;
  nfLegalName: string | null;
  /** First `ADMIN_EMAILS` entry, lowercased. */
  nfOwnerEmail: string | null;
  /** `DEFAULT_ORG_OWNER_EMAIL`, lowercased. */
  defaultOwnerEmail: string | null;
}

/** One org the IdP mirror covers. */
export interface RootOrgState {
  id: string;
  slug: string;
  name: string;
  kcGroupId: string | null;
  ownerUserId: string;
  /** The owner's email (contact), lowercased. */
  ownerEmail: string;
  /** The owner's recorded IdP subject, if any. */
  ownerSubject: string | null;
  /**
   * Whether the owner's person also holds a coordinator account. Its IdP user
   * (one per person) then belongs to that login, so the mirror never links or
   * creates one for the admin account.
   */
  ownerIsCoordinator: boolean;
}

/** An owner replaced by the reconcile: removed from the org's group. */
export interface ReplacedOwner {
  orgId: string;
  subject: string;
}

/** What the database reconcile found and changed. */
export interface RootState {
  root: RootOrgState;
  defaultOrg: RootOrgState;
  changed: { slug: boolean; name: boolean; rootOwner: boolean; defaultOwner: boolean };
  /** Owners replaced in this run that had a recorded IdP subject. */
  replacedOwners: ReplacedOwner[];
}

/**
 * Builds the root config from the network config and environment.
 *
 * @param network - The resolved aggregator block (`url_slug`, names).
 * @param adminEmails - Parsed `ADMIN_EMAILS`.
 * @param defaultOwnerEmail - `DEFAULT_ORG_OWNER_EMAIL`, or `null`.
 * @returns The config to reconcile against.
 */
export function rootConfigFrom(
  network: { urlSlug?: string | null; name?: string | null; legalName?: string | null } | null,
  adminEmails: readonly string[],
  defaultOwnerEmail: string | null,
): RootConfig {
  const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  const legal = clean(network?.legalName);
  return {
    nfSlug: clean(network?.urlSlug),
    nfName: legal ?? clean(network?.name),
    nfLegalName: legal,
    nfOwnerEmail: clean(adminEmails[0])?.toLowerCase() ?? null,
    defaultOwnerEmail: clean(defaultOwnerEmail)?.toLowerCase() ?? null,
  };
}

/**
 * The admin account for an owner email: reuses the person's existing contact
 * (whatever its phone), else creates a phone-less one.
 *
 * @param tx - The caller's transaction.
 * @param email - Lowercased owner email.
 * @returns The admin account's `users.id`.
 */
async function adminAccountFor(tx: DbExecutor, email: string): Promise<string> {
  const found = await tx.execute<{ id: string }>(
    sql`SELECT id FROM contact WHERE email = ${email}`,
  );
  const contactId =
    found.rows[0]?.id ?? (await linkContact(tx, { email, phone: null, name: null }));
  return linkAdminAccount(tx, contactId);
}

/**
 * Deletes an admin account that owns no org any more (the placeholder after
 * the configured owner took over); its contact is then collected by the
 * `users_contact_ad` trigger.
 */
async function releaseIfUnowned(tx: DbExecutor, userId: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM users u
     WHERE u.id = ${userId} AND u.user_type = 'admin'
       AND NOT EXISTS (SELECT 1 FROM organisations o WHERE o.org_owner = ${userId})`);
}

/** Reads the root or the Default org with its owner. */
async function readOrg(tx: DbExecutor, where: 'root' | 'default'): Promise<RootOrgState | null> {
  const filter =
    where === 'root'
      ? sql`o.org_type = 'network_facilitator'`
      : sql`o.org_type = 'aggregator' AND o.slug = 'default'`;
  const rows = await tx.execute<{
    id: string;
    slug: string;
    name: string;
    kc_group_id: string | null;
    org_owner: string;
    email: string;
    subject: string | null;
    is_coordinator: boolean;
  }>(sql`
    SELECT o.id, o.slug, o.name, o.kc_group_id, o.org_owner, c.email, i.subject,
           EXISTS (SELECT 1 FROM users x
                    WHERE x.contact_id = u.contact_id AND x.user_type = 'coordinator') AS is_coordinator
      FROM organisations o
      JOIN users u ON u.id = o.org_owner
      JOIN contact c ON c.id = u.contact_id
      LEFT JOIN user_identities i ON i.user_id = u.id AND i.provider = ${IDP_PROVIDER}
     WHERE ${filter}
     LIMIT 1`);
  const r = rows.rows[0];
  return r
    ? {
        id: r.id,
        slug: r.slug,
        name: r.name,
        kcGroupId: r.kc_group_id,
        ownerUserId: r.org_owner,
        ownerEmail: r.email,
        ownerSubject: r.subject,
        ownerIsCoordinator: Boolean(r.is_coordinator),
      }
    : null;
}

/**
 * Reconciles the root and the Default org with config in one transaction.
 *
 * @param cfg - The configured values.
 * @param db - Executor (defaults to the pool).
 * @returns The resulting state, or `null` when the database predates 0028.
 */
export async function reconcileRootOrganisations(
  cfg: RootConfig,
  db: ReturnType<typeof getDb> = getDb(),
): Promise<RootState | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:ensure-root'))`);
    const reg = await tx.execute<{ t: string | null }>(
      sql`SELECT to_regclass('public.organisations')::text AS t`,
    );
    if (!reg.rows[0]?.t) return null;
    const root = await readOrg(tx, 'root');
    const dflt = await readOrg(tx, 'default');
    if (!root || !dflt) return null;
    const changed = { slug: false, name: false, rootOwner: false, defaultOwner: false };

    // Root slug: applied only when no live org already holds it.
    if (cfg.nfSlug && cfg.nfSlug !== root.slug) {
      const taken = await tx.execute(sql`
        SELECT 1 FROM organisations
         WHERE slug = ${cfg.nfSlug} AND id <> ${root.id} AND status IN ('pending','active')`);
      if (taken.rows.length === 0) {
        await tx.execute(sql`UPDATE organisations SET slug = ${cfg.nfSlug} WHERE id = ${root.id}`);
        changed.slug = true;
      } else {
        logger.warn(
          { operation: 'ensureRootOrganisation', status: 'skipped', reason: 'slug_taken' },
          'configured network slug is held by another org — keeping the current one',
        );
      }
    }
    if (cfg.nfName && cfg.nfName !== root.name) {
      await tx.execute(sql`UPDATE organisations SET name = ${cfg.nfName} WHERE id = ${root.id}`);
      changed.name = true;
    }
    if (cfg.nfLegalName) {
      await tx.execute(sql`
        UPDATE organisations SET legal_name = ${cfg.nfLegalName}
         WHERE id = ${root.id} AND legal_name IS DISTINCT FROM ${cfg.nfLegalName}`);
    }

    // Owners.
    let rootOwner = root.ownerUserId;
    if (cfg.nfOwnerEmail && cfg.nfOwnerEmail !== root.ownerEmail) {
      rootOwner = await adminAccountFor(tx, cfg.nfOwnerEmail);
      if (rootOwner !== root.ownerUserId) {
        await tx.execute(
          sql`UPDATE organisations SET org_owner = ${rootOwner} WHERE id = ${root.id}`,
        );
        changed.rootOwner = true;
      }
    }
    const defaultOwner = cfg.defaultOwnerEmail
      ? await adminAccountFor(tx, cfg.defaultOwnerEmail)
      : rootOwner;
    if (defaultOwner !== dflt.ownerUserId) {
      await tx.execute(
        sql`UPDATE organisations SET org_owner = ${defaultOwner} WHERE id = ${dflt.id}`,
      );
      changed.defaultOwner = true;
    }
    // Remember the replaced owners' IdP subjects before their accounts (and
    // identities) are released, so the mirror can take them out of the group.
    const replacedOwners: ReplacedOwner[] = [
      ...(changed.rootOwner && root.ownerSubject
        ? [{ orgId: root.id, subject: root.ownerSubject }]
        : []),
      ...(changed.defaultOwner && dflt.ownerSubject
        ? [{ orgId: dflt.id, subject: dflt.ownerSubject }]
        : []),
    ];
    if (changed.rootOwner) await releaseIfUnowned(tx, root.ownerUserId);
    if (changed.defaultOwner) await releaseIfUnowned(tx, dflt.ownerUserId);

    const nextRoot = await readOrg(tx, 'root');
    const nextDefault = await readOrg(tx, 'default');
    if (!nextRoot || !nextDefault) return null;
    return { root: nextRoot, defaultOrg: nextDefault, changed, replacedOwners };
  });
}

/** Writes the IdP mirror results back to the database. */
export interface RootIdpRecorder {
  setGroupId(orgId: string, groupId: string): Promise<void>;
  /** Records the owner's IdP subject; resolves `false` when it conflicts. */
  linkSubject(userId: string, subject: string): Promise<boolean>;
}

/** Counts of what the IdP mirror did. */
export interface RootIdpReport {
  groupsCreated: number;
  /** Groups found by name from an earlier attempt and adopted. */
  groupsAdopted: number;
  usersCreated: number;
  usersReused: number;
  /** Replaced owners removed from their org's group. */
  ownersRemoved: number;
  failures: number;
}

/**
 * Creates the org's group, or adopts it when an earlier attempt created it but
 * its id was never recorded (Keycloak answers 409): the existing group is
 * adopted only when its `org_id` attribute names this org.
 *
 * The name is `org-<slug>-<first 8 of the org id>`: the root's and the Default
 * org's slugs are the same on every instance (`default`, the brand slug), so a
 * plain `org-<slug>` would collide on a realm shared by several instances or
 * with a group left by a recreated database. (Aggregator orgs' slugs already
 * carry a random suffix.)
 *
 * @returns The group id, or `null` (counted as a failure, retried next boot).
 */
async function ensureGroup(
  idp: IdpAdminAdapter,
  org: RootOrgState,
  report: RootIdpReport,
  fail: (step: string, code: string) => void,
): Promise<string | null> {
  const name = `org-${org.slug}-${org.id.slice(0, 8)}`;
  const created = await idp.createGroup(name, { org_id: org.id, display_name: org.name });
  if (created.ok) {
    report.groupsCreated += 1;
    return created.value.id;
  }
  if (created.error.code !== 'BAD_REQUEST') {
    fail('createGroup', created.error.code);
    return null;
  }
  const found = await idp.findGroupByName(name);
  if (!found.ok) {
    fail('findGroupByName', found.error.code);
    return null;
  }
  if (found.value && (found.value.attributes['org_id'] ?? []).includes(org.id)) {
    report.groupsAdopted += 1;
    return found.value.id;
  }
  // The name belongs to another org (another instance on a shared realm, or a
  // renamed old org): never take it over.
  fail('createGroup', 'group_name_taken');
  return null;
}

/**
 * Mirrors the root and the Default org into the IdP, as org registration does:
 * a group per org (`org-<slug>`) and, for each configured owner, a disabled
 * user — or the existing user for that email, reused untouched. Owners stay
 * disabled and get no role (owner login is Phase 5). Never throws.
 *
 * @param idp - The IdP admin adapter.
 * @param state - The reconciled orgs.
 * @param recorder - Persists group ids and subjects.
 * @returns Counts for the boot log.
 */
export async function provisionRootIdp(
  idp: IdpAdminAdapter,
  state: Pick<RootState, 'root' | 'defaultOrg'> & Partial<Pick<RootState, 'replacedOwners'>>,
  recorder: RootIdpRecorder,
): Promise<RootIdpReport> {
  const report: RootIdpReport = {
    groupsCreated: 0,
    groupsAdopted: 0,
    usersCreated: 0,
    usersReused: 0,
    ownersRemoved: 0,
    failures: 0,
  };
  const fail = (step: string, code: string) => {
    report.failures += 1;
    logger.warn(
      { operation: 'ensureRootOrganisation.idp', status: 'failure', step, error: code },
      'IdP mirror step failed — retried on the next boot',
    );
  };

  for (const org of [state.root, state.defaultOrg]) {
    let groupId = org.kcGroupId;
    if (!groupId) {
      groupId = await ensureGroup(idp, org, report, fail);
      if (groupId) await recorder.setGroupId(org.id, groupId);
    }

    // Owners replaced by the reconcile leave the org's group (their IdP user
    // is never deleted: it may be a person with other roles).
    for (const gone of (state.replacedOwners ?? []).filter((r) => r.orgId === org.id)) {
      if (!groupId) break;
      const removed = await idp.removeUserFromGroup(gone.subject, groupId);
      if (removed.ok) report.ownersRemoved += 1;
      else fail('removeUserFromGroup', removed.error.code);
    }

    if (org.ownerEmail === PLACEHOLDER_OWNER_EMAIL) continue;
    // One IdP user per person: if the owner is also a coordinator, that user
    // is the coordinator's login and must not be linked to the admin account.
    if (org.ownerIsCoordinator && !org.ownerSubject) {
      logger.warn(
        {
          operation: 'ensureRootOrganisation.idp',
          status: 'skipped',
          reason: 'owner_is_coordinator',
        },
        'the configured owner also holds a coordinator account — no admin IdP user is linked',
      );
      continue;
    }
    let subject = org.ownerSubject;
    if (!subject) {
      const existing = await idp.findByEmail(org.ownerEmail);
      if (!existing.ok) {
        fail('findByEmail', existing.error.code);
        continue;
      }
      if (existing.value) {
        subject = existing.value.id;
        report.usersReused += 1;
      } else {
        const created = await idp.createUser({
          email: org.ownerEmail,
          username: org.ownerEmail,
          enabled: false,
          attributes: { [KC_ATTR.DECISION_MADE]: 'pending' },
        });
        if (!created.ok) {
          fail('createUser', created.error.code);
          continue;
        }
        subject = created.value.id;
        report.usersCreated += 1;
      }
      if (!(await recorder.linkSubject(org.ownerUserId, subject))) {
        fail('linkSubject', 'identity_conflict');
        continue;
      }
    }
    if (groupId) {
      const added = await idp.addUserToGroup(subject, groupId);
      if (!added.ok) fail('addUserToGroup', added.error.code);
    }
  }
  return report;
}

/** Database-backed {@link RootIdpRecorder}. */
export const dbRootIdpRecorder: RootIdpRecorder = {
  async setGroupId(orgId, groupId) {
    await getDb().execute(
      sql`UPDATE organisations SET kc_group_id = ${groupId} WHERE id = ${orgId} AND kc_group_id IS NULL`,
    );
  },
  async linkSubject(userId, subject) {
    try {
      await getDb().transaction((tx) => linkIdentity(tx, userId, IDP_PROVIDER, subject, 'admin'));
      return true;
    } catch (e) {
      if (e instanceof IdentityTakenError || e instanceof IdentityMismatchError) return false;
      throw e;
    }
  },
};

/**
 * Runs the database reconcile at boot (awaited before the server listens).
 * Never throws: a failure is logged and the next boot retries.
 *
 * @param cfg - The configured values.
 * @returns The reconciled state for {@link mirrorRootOrganisations}, or `null`.
 */
export async function ensureRootOrganisation(cfg: RootConfig): Promise<RootState | null> {
  const start = Date.now();
  try {
    const state = await reconcileRootOrganisations(cfg);
    if (!state) {
      logger.info(
        { operation: 'ensureRootOrganisation', status: 'skipped', reason: 'no_root' },
        'no network root (database predates migration 0028)',
      );
      return null;
    }
    if (!cfg.nfOwnerEmail) {
      logger.warn(
        { operation: 'ensureRootOrganisation', status: 'skipped', reason: 'no_admin_email' },
        'ADMIN_EMAILS is empty — the network root keeps its placeholder owner',
      );
    }
    logger.info({
      operation: 'ensureRootOrganisation',
      status: 'success',
      latency_ms: Date.now() - start,
      ...state.changed,
      replaced_owners: state.replacedOwners.length,
    });
    return state;
  } catch (err) {
    logger.error({
      operation: 'ensureRootOrganisation',
      status: 'failure',
      // Never the driver message: Drizzle includes the query parameters (emails).
      error: pgErrorCode(err) ? `database error ${pgErrorCode(err)}` : 'reconcile failed',
      error_type: (err as Error | undefined)?.constructor?.name ?? 'unknown',
      latency_ms: Date.now() - start,
    });
    return null;
  }
}

/**
 * Mirrors the reconciled orgs into the IdP. Runs AFTER the server listens
 * (fire-and-forget at boot), so a slow or unreachable IdP never delays
 * readiness. Never throws.
 *
 * @param state - The state {@link ensureRootOrganisation} returned.
 * @param idp - The IdP admin adapter.
 */
export async function mirrorRootOrganisations(
  state: RootState,
  idp: IdpAdminAdapter,
): Promise<void> {
  const start = Date.now();
  try {
    const report = await provisionRootIdp(idp, state, dbRootIdpRecorder);
    logger.info({
      operation: 'ensureRootOrganisation.idp',
      status: report.failures > 0 ? 'failure' : 'success',
      latency_ms: Date.now() - start,
      ...report,
    });
  } catch (err) {
    logger.error({
      operation: 'ensureRootOrganisation.idp',
      status: 'failure',
      error: pgErrorCode(err) ? `database error ${pgErrorCode(err)}` : 'mirror failed',
      error_type: (err as Error | undefined)?.constructor?.name ?? 'unknown',
      latency_ms: Date.now() - start,
    });
  }
}
