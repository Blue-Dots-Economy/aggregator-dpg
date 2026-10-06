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
}

/** What the database reconcile found and changed. */
export interface RootState {
  root: RootOrgState;
  defaultOrg: RootOrgState;
  changed: { slug: boolean; name: boolean; rootOwner: boolean; defaultOwner: boolean };
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
  }>(sql`
    SELECT o.id, o.slug, o.name, o.kc_group_id, o.org_owner, c.email, i.subject
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
    if (changed.rootOwner) await releaseIfUnowned(tx, root.ownerUserId);
    if (changed.defaultOwner) await releaseIfUnowned(tx, dflt.ownerUserId);

    const nextRoot = await readOrg(tx, 'root');
    const nextDefault = await readOrg(tx, 'default');
    if (!nextRoot || !nextDefault) return null;
    return { root: nextRoot, defaultOrg: nextDefault, changed };
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
  usersCreated: number;
  usersReused: number;
  failures: number;
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
  state: Pick<RootState, 'root' | 'defaultOrg'>,
  recorder: RootIdpRecorder,
): Promise<RootIdpReport> {
  const report: RootIdpReport = { groupsCreated: 0, usersCreated: 0, usersReused: 0, failures: 0 };
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
      const g = await idp.createGroup(`org-${org.slug}`, {
        org_id: org.id,
        display_name: org.name,
      });
      if (g.ok) {
        groupId = g.value.id;
        await recorder.setGroupId(org.id, groupId);
        report.groupsCreated += 1;
      } else {
        fail('createGroup', g.error.code);
      }
    }

    if (org.ownerEmail === PLACEHOLDER_OWNER_EMAIL) continue;
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
 * Runs the reconcile and the IdP mirror at boot. Never throws: a failure is
 * logged and the next boot retries.
 *
 * @param cfg - The configured values.
 * @param idp - The IdP admin adapter.
 */
export async function ensureRootOrganisation(cfg: RootConfig, idp: IdpAdminAdapter): Promise<void> {
  const start = Date.now();
  try {
    const state = await reconcileRootOrganisations(cfg);
    if (!state) {
      logger.info(
        { operation: 'ensureRootOrganisation', status: 'skipped', reason: 'no_root' },
        'no network root (database predates migration 0028)',
      );
      return;
    }
    if (!cfg.nfOwnerEmail) {
      logger.warn(
        { operation: 'ensureRootOrganisation', status: 'skipped', reason: 'no_admin_email' },
        'ADMIN_EMAILS is empty — the network root keeps its placeholder owner',
      );
    }
    const idpReport = await provisionRootIdp(idp, state, dbRootIdpRecorder);
    logger.info({
      operation: 'ensureRootOrganisation',
      status: 'success',
      latency_ms: Date.now() - start,
      ...state.changed,
      ...idpReport,
    });
  } catch (err) {
    logger.error({
      operation: 'ensureRootOrganisation',
      status: 'failure',
      // Never the driver message: Drizzle includes the query parameters (emails).
      error: pgErrorCode(err) ? `database error ${pgErrorCode(err)}` : 'reconcile failed',
      error_type: (err as Error | undefined)?.constructor?.name ?? 'unknown',
      latency_ms: Date.now() - start,
    });
  }
}
