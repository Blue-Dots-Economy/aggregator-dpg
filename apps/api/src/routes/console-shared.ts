/**
 * Shared helpers of the console routes `/v1/user/*` and `/v1/org/*`
 * (`@aggregator-dpg/api`, user & org Phase 5): wire mappers, keyset cursors,
 * the per-actor write limit, decision-outcome mapping and the owner notice.
 *
 * Logging rule for every console action (design R12 / C8): actor id, target
 * id and field names only — never values, never contact data, never a
 * decision reason.
 */

import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import { getMailer } from '@aggregator-dpg/mailer';
import type { Org, User } from '@aggregator-dpg/shared-primitives/user-org';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';
import type { Aggregator } from '../services/aggregator-store/index.js';
import type { AggregatorOrg } from '../services/aggregator-org-store/index.js';
import type { CoordinatorCursor } from '../services/aggregator-store/interface.js';
import type { OrgCursor } from '../services/aggregator-org-store/interface.js';
import { isNetworkAdmin, type Actor } from '../services/auth/actor/index.js';
import { checkConsoleWriteRate } from '../services/console-rate.js';
import { renderOrgAdminAction } from '../services/email-templates/index.js';
import type { DecisionOutcome } from '../services/decisions/coordinator.js';

/** The console's landing URL, used in owner notices. */
export function consoleUrl(): string {
  return `${config.PUBLIC_PORTAL_URL}/console`;
}

/**
 * Masks an email address: the first character of the local part, then `***`,
 * then the domain (`a***@example.org`). Shows that an address exists without
 * revealing it.
 *
 * @param email - The address.
 * @returns The masked address; `***` when it has no `@`.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/**
 * Masks a phone number to its last four digits (`******1234`).
 *
 * @param phone - The number, or null.
 * @returns The masked number, or null.
 */
export function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * A coordinator on the wire.
 *
 * @param a - The coordinator.
 * @param opts - `masked`: hide the email and phone (RBAC: the caller lacks
 *   `contact.unmask`). The name is always shown.
 * @returns The `UserSchema` shape.
 */
export function toWireUser(a: Aggregator, opts: { masked?: boolean } = {}): User {
  const phone = a.contact.phone ?? null;
  return {
    id: a.id,
    user_type: 'coordinator',
    status: a.status,
    name: a.name,
    contact: {
      name: a.contact.name ?? null,
      email: opts.masked ? maskEmail(a.contact.email) : a.contact.email,
      phone: opts.masked ? maskPhone(phone) : phone,
    },
    serves: a.serves,
    org_id: a.parentOrgId,
    invited: a.inviteId !== null,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
    rejected_at: a.rejectedAt ? a.rejectedAt.toISOString() : null,
  };
}

/**
 * An organisation on the wire.
 *
 * @param o - The org.
 * @param orgType - `network_facilitator` for the root, else `aggregator`.
 * @returns The `OrgSchema` shape.
 */
export function toWireOrg(
  o: AggregatorOrg,
  orgType: 'network_facilitator' | 'aggregator' = 'aggregator',
): Org {
  return {
    id: o.id,
    slug: o.slug,
    name: o.displayName,
    org_type: orgType,
    status: o.status,
    is_default: o.isDefault,
    url: o.url,
    locations: o.locations,
    legal_name: o.legalName,
    gst_number: o.gstNumber,
    created_at: o.createdAt.toISOString(),
    updated_at: o.updatedAt.toISOString(),
  };
}

/** The owner's contact on the wire. */
export function ownerContact(o: AggregatorOrg): {
  name: string | null;
  email: string;
  phone: string | null;
} {
  return { name: o.ownerName, email: o.ownerEmail, phone: o.ownerPhone };
}

const encode = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

function decode(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    // An unreadable cursor is a client error, answered below.
    return null;
  }
}

const badCursor = () =>
  httpError('SCHEMA_VALIDATION', { detail: 'cursor is invalid', fields: { field: 'cursor' } });

/** Encodes a coordinator page cursor. */
export function encodeUserCursor(c: CoordinatorCursor): string {
  return encode({ c: c.createdAt.toISOString(), i: c.id });
}

/**
 * Decodes a coordinator page cursor.
 *
 * @throws {HttpError} SCHEMA_VALIDATION when malformed.
 */
export function decodeUserCursor(cursor: string): CoordinatorCursor {
  const v = decode(cursor) as { c?: unknown; i?: unknown } | null;
  if (!v || typeof v.c !== 'string' || typeof v.i !== 'string') throw badCursor();
  const createdAt = new Date(v.c);
  if (Number.isNaN(createdAt.getTime())) throw badCursor();
  return { createdAt, id: v.i };
}

/** Encodes an org page cursor. */
export function encodeOrgCursor(c: OrgCursor): string {
  return encode({ n: c.name, i: c.id });
}

/**
 * Decodes an org page cursor.
 *
 * @throws {HttpError} SCHEMA_VALIDATION when malformed.
 */
export function decodeOrgCursor(cursor: string): OrgCursor {
  const v = decode(cursor) as { n?: unknown; i?: unknown } | null;
  if (!v || typeof v.n !== 'string' || typeof v.i !== 'string') throw badCursor();
  return { name: v.n, id: v.i };
}

/**
 * Consumes one console write for the actor, or throws `RATE_LIMITED`.
 *
 * @param actor - The acting admin.
 * @param reply - For the `Retry-After` header.
 * @throws {HttpError} RATE_LIMITED.
 */
export async function guardWriteRate(actor: Actor, reply: FastifyReply): Promise<void> {
  const rl = await checkConsoleWriteRate(actor.userId);
  if (rl.allowed) return;
  void reply.header('Retry-After', String(rl.retryAfterSeconds));
  throw httpError('RATE_LIMITED', {
    detail: `Retry in ${rl.retryAfterSeconds}s.`,
    fields: { retry_after_seconds: rl.retryAfterSeconds },
  });
}

/**
 * Throws the HTTP error of a coordinator decision that did not succeed.
 *
 * @param outcome - A non-`decided` outcome.
 * @throws {HttpError} Always.
 */
export function throwDecisionFailure(
  outcome: Exclude<DecisionOutcome, { kind: 'decided' }>,
): never {
  switch (outcome.kind) {
    case 'already_decided':
      throw httpError('ALREADY_DECIDED', {
        fields: {
          status: outcome.status,
          decided_at: outcome.decidedAt.toISOString(),
          decided_by: outcome.decidedBy,
        },
      });
    case 'not_found':
      throw httpError('NOT_FOUND');
    case 'org_inactive':
      throw httpError('TARGET_ORG_INACTIVE');
    case 'unavailable':
      if (outcome.dependency === 'signalstack') throw httpError('SIGNALSTACK_PUSH_FAILED');
      if (outcome.dependency === 'idp') throw httpError('IDP_UNAVAILABLE');
      throw httpError('DB_UNAVAILABLE');
  }
}

/**
 * Tells an org's owner that the network admin acted in their org (design
 * C13). Skipped when the actor owns the org itself. Best effort: a failed
 * send is logged and never fails the action.
 *
 * @param actor - The acting admin.
 * @param org - The org acted on.
 * @param action - What was done, e.g. "approved a coordinator" (no values).
 * @param log - Request logger.
 */
export async function notifyOwnerOfAdminAction(
  actor: Actor,
  org: AggregatorOrg,
  action: string,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!isNetworkAdmin(actor) || org.ownerUserId === actor.userId) return;
  const mail = renderOrgAdminAction({ orgName: org.displayName, action, consoleUrl: consoleUrl() });
  const sent = await getMailer().send({
    to: org.ownerEmail,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!sent.ok) {
    log.warn({
      status: 'failure',
      sub_operation: 'mailer.send.orgAdminAction',
      org_id: org.id,
      code: sent.error.code,
    });
  }
}

/**
 * Joins field names into a phrase: `["url", "locations"]` → "url and locations".
 *
 * @param names - Field labels.
 * @returns The phrase.
 */
export function listPhrase(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
