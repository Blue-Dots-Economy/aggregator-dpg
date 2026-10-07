/**
 * In-memory aggregator store.
 *
 * Process-local Maps, suitable for unit tests. Mirrors the Postgres adapter's
 * external behaviour: unique slug / phone / email, `serves` from `type`, the
 * fail-closed consent hook, immutable slug on update, and org details rendered from the
 * coordinator's org with the `legacy_org_details` fallback (0028). Org details
 * are seeded per org id (`AggregatorStoreFake.seedOrgDetails`); the Default org
 * is {@link MEMORY_DEFAULT_ORG_ID} unless a test changes it.
 */

import { randomUUID } from 'node:crypto';
import {
  AggregatorStoreBase,
  type Aggregator,
  type CreateAggregatorInput,
  type ListAggregatorsFilter,
  type ListAggregatorsPage,
  type StoreError,
  type StoreResult,
  type UpdateAggregatorPatch,
} from './interface.js';
import type { AggregatorStatus, BecknContact } from '@aggregator-dpg/shared-primitives/aggregator';
import { renderOrgDetails, type OrgDetailColumns } from './org-details.js';
import { servesOf } from './serves.js';
import type { LegacyOrgDetails } from './interface.js';

/** The Default org's id in the in-memory store (matches `buildDefaultOrg`). */
export const MEMORY_DEFAULT_ORG_ID = '00000000-0000-0000-0000-0000000000d0';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';

/**
 * The contact id for this email + phone, or `null` when the phone is not
 * canonical — the Postgres store rejects that write as `CHECK_VIOLATION`.
 */
function safeContactId(email: string, phone: string): string | null {
  try {
    return contactId(email, phone);
  } catch {
    return null;
  }
}

export class InMemoryAggregatorStore extends AggregatorStoreBase {
  protected readonly byId = new Map<string, Aggregator>();
  protected readonly bySlug = new Map<string, string>();
  protected readonly byPhone = new Map<string, string>();
  protected readonly byEmail = new Map<string, string>();

  /** Org-detail columns per org id (seeded by tests). */
  protected readonly orgDetails = new Map<string, OrgDetailColumns>();
  /** Each coordinator's own `legacy_org_details`. */
  protected readonly legacy = new Map<string, LegacyOrgDetails | null>();
  /** Which org id is the Default org. */
  protected defaultOrgId: string = MEMORY_DEFAULT_ORG_ID;
  /** Invite addresses by `jti` (the Postgres store reads them from `registration_invites`). */
  protected readonly inviteEmails = new Map<string, string>();

  /**
   * Renders org details and the composed contact as Postgres does: company /
   * GST come from the org (or the coordinator's legacy values), never from
   * the submitted contact.
   */
  private render(
    orgId: string,
    legacy: LegacyOrgDetails | null,
    submitted: BecknContact,
  ): { url: string | null; locations: Aggregator['locations']; contact: BecknContact } {
    const d = renderOrgDetails(this.orgDetails.get(orgId) ?? null, legacy);
    const { name, email, phone, alternatePhone } = submitted;
    return {
      url: d.url,
      locations: d.locations,
      contact: {
        name,
        email,
        phone,
        ...(d.company !== undefined ? { company: d.company } : {}),
        ...(d.gstNumber !== undefined ? { gstNumber: d.gstNumber } : {}),
        ...(alternatePhone !== undefined ? { alternatePhone } : {}),
      },
    };
  }

  /**
   * Re-renders a row's org details on read, as the Postgres join does, so org
   * details seeded after a coordinator was created are reflected. Rows whose
   * org has no seeded details and that hold no legacy values are returned as
   * stored (rows seeded directly by tests keep their own url / locations).
   */
  protected view(row: Aggregator): Aggregator {
    const orgId = row.parentOrgId;
    const legacy = this.legacy.get(row.id) ?? null;
    if (!orgId || (!this.orgDetails.has(orgId) && !legacy)) return row;
    const rendered = this.render(orgId, legacy, row.contact);
    return { ...row, url: rendered.url, locations: rendered.locations, contact: rendered.contact };
  }

  /** {@link view} for a possibly-missing row. */
  protected viewOrNull(row: Aggregator | undefined): Aggregator | null {
    return row ? this.view(row) : null;
  }

  async create(input: CreateAggregatorInput): Promise<StoreResult<Aggregator>> {
    if (this.bySlug.has(input.orgSlug)) {
      return errResult('DUPLICATE_SLUG', `slug already exists: ${input.orgSlug}`);
    }
    const phone = input.contact.phone;
    const email = input.contact.email.toLowerCase();
    if (this.byPhone.has(phone)) {
      return errResult('DUPLICATE_PHONE', `phone already exists: ${phone}`);
    }
    if (this.byEmail.has(email)) {
      return errResult('DUPLICATE_EMAIL', `email already exists: ${email}`);
    }

    const cid = safeContactId(email, phone);
    if (!cid) return errResult('CHECK_VIOLATION', 'contactId: phone must be canonical');

    const id = randomUUID();
    // Fail-closed like the Postgres transaction: nothing is stored when the
    // consent write fails.
    if (input.recordConsent) {
      try {
        await input.recordConsent(undefined, id);
      } catch {
        return errResult('CONSENT_WRITE_FAILED', 'consent could not be recorded');
      }
    }

    const now = new Date();
    this.legacy.set(id, input.legacyOrgDetails ?? null);
    const rendered = this.render(input.orgId, input.legacyOrgDetails ?? null, input.contact);
    const serves = servesOf(input.type);
    const row: Aggregator = {
      id,
      orgSlug: input.orgSlug,
      actorType: 'aggregator',
      name: input.name,
      type: serves[0] ?? null,
      serves,
      url: rendered.url,
      contactId: cid,
      contact: rendered.contact,
      contactPhone: phone,
      contactEmail: email,
      locations: rendered.locations,
      consent: input.consent,
      profile: input.profile ?? {},
      profileRef: input.profileRef ?? null,
      status: 'pending',
      createdBy: input.createdBy,
      updatedBy: input.updatedBy,
      createdAt: now,
      updatedAt: now,
      signalstackOrgId: null,
      parentOrgId: input.orgId,
      isDefaultOrg: input.orgId === this.defaultOrgId,
      inviteEmail: input.inviteId ? (this.inviteEmails.get(input.inviteId) ?? null) : null,
      inviteId: input.inviteId ?? null,
      rejectedAt: null,
    };
    this.indexInsert(row);
    return { ok: true, value: this.view(row) };
  }

  findById(id: string): Promise<StoreResult<Aggregator | null>> {
    return Promise.resolve({ ok: true, value: this.viewOrNull(this.byId.get(id)) });
  }

  findBySlug(orgSlug: string): Promise<StoreResult<Aggregator | null>> {
    const id = this.bySlug.get(orgSlug);
    return Promise.resolve({ ok: true, value: id ? this.viewOrNull(this.byId.get(id)) : null });
  }

  findByContactPhone(phone: string): Promise<StoreResult<Aggregator | null>> {
    const id = this.byPhone.get(phone);
    return Promise.resolve({ ok: true, value: id ? this.viewOrNull(this.byId.get(id)) : null });
  }

  findByContactEmail(email: string): Promise<StoreResult<Aggregator | null>> {
    const id = this.byEmail.get(email.toLowerCase());
    return Promise.resolve({ ok: true, value: id ? this.viewOrNull(this.byId.get(id)) : null });
  }

  findByParentOrgId(orgId: string): Promise<StoreResult<Aggregator[]>> {
    return Promise.resolve({
      ok: true,
      value: [...this.byId.values()]
        .filter((r) => r.parentOrgId === orgId)
        .map((r) => this.view(r)),
    });
  }

  list(filter: ListAggregatorsFilter): Promise<StoreResult<ListAggregatorsPage>> {
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    let rows = [...this.byId.values()];
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.updatedBefore) {
      const before = filter.updatedBefore.getTime();
      rows = rows.filter((r) => r.updatedAt.getTime() < before);
    }
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve({
      ok: true,
      value: {
        rows: rows.slice(offset, offset + limit).map((r) => this.view(r)),
        total: rows.length,
      },
    });
  }

  update(id: string, patch: UpdateAggregatorPatch): Promise<StoreResult<Aggregator>> {
    const existing = this.byId.get(id);
    if (!existing) return Promise.resolve(errResult('NOT_FOUND', id));

    let nextPhone = existing.contactPhone;
    let nextEmail = existing.contactEmail;
    let nextContact = existing.contact;
    if (patch.contact) {
      nextContact = existing.parentOrgId
        ? this.render(existing.parentOrgId, this.legacy.get(id) ?? null, patch.contact).contact
        : patch.contact;
      nextPhone = patch.contact.phone;
      nextEmail = patch.contact.email.toLowerCase();
      if (nextPhone !== existing.contactPhone && this.byPhone.has(nextPhone)) {
        return Promise.resolve(errResult('DUPLICATE_PHONE', `phone already exists: ${nextPhone}`));
      }
      if (nextEmail !== existing.contactEmail && this.byEmail.has(nextEmail)) {
        return Promise.resolve(errResult('DUPLICATE_EMAIL', `email already exists: ${nextEmail}`));
      }
    }

    const nextId = safeContactId(nextEmail, nextPhone);
    if (!nextId)
      return Promise.resolve(errResult('CHECK_VIOLATION', 'contactId: phone must be canonical'));

    const next: Aggregator = {
      ...existing,
      name: patch.name ?? existing.name,
      ...(patch.type !== undefined
        ? { serves: servesOf(patch.type), type: servesOf(patch.type)[0] ?? null }
        : {}),
      contactId: nextId,
      contact: nextContact,
      contactPhone: nextPhone,
      contactEmail: nextEmail,
      status: patch.status ?? existing.status,
      rejectedAt: patch.rejectedAt !== undefined ? patch.rejectedAt : existing.rejectedAt,
      updatedBy: patch.updatedBy,
      updatedAt: new Date(),
    };
    this.indexReplace(existing, next);
    return Promise.resolve({ ok: true, value: this.view(next) });
  }

  async updateStatus(
    id: string,
    status: AggregatorStatus,
    updatedBy: string,
  ): Promise<StoreResult<Aggregator>> {
    return this.update(id, { status, updatedBy });
  }

  async approveFromPending(id: string, updatedBy: string): Promise<StoreResult<Aggregator | null>> {
    const existing = this.byId.get(id);
    // Only pending → active; anything else means already decided.
    if (!existing || existing.status !== 'pending') return { ok: true, value: null };
    return this.update(id, { status: 'active', updatedBy });
  }

  updateSignalstackOrgId(
    id: string,
    signalstackOrgId: string,
    updatedBy: string,
  ): Promise<StoreResult<Aggregator>> {
    const existing = this.byId.get(id);
    if (!existing) return Promise.resolve(errResult('NOT_FOUND', id));
    const next: Aggregator = {
      ...existing,
      signalstackOrgId,
      updatedBy,
      updatedAt: new Date(),
    };
    this.byId.set(id, next);
    return Promise.resolve({ ok: true, value: this.view(next) });
  }

  deleteById(id: string): Promise<StoreResult<void>> {
    const row = this.byId.get(id);
    if (!row) return Promise.resolve(errResult('NOT_FOUND', id));
    this.byId.delete(id);
    this.bySlug.delete(row.orgSlug);
    this.byPhone.delete(row.contactPhone);
    this.byEmail.delete(row.contactEmail);
    return Promise.resolve({ ok: true, value: undefined });
  }

  // ─── Index maintenance ────────────────────────────────────────────────────

  protected indexInsert(row: Aggregator): void {
    this.byId.set(row.id, row);
    this.bySlug.set(row.orgSlug, row.id);
    this.byPhone.set(row.contactPhone, row.id);
    this.byEmail.set(row.contactEmail, row.id);
  }

  protected indexReplace(prev: Aggregator, next: Aggregator): void {
    this.byId.set(next.id, next);
    if (prev.contactPhone !== next.contactPhone) {
      this.byPhone.delete(prev.contactPhone);
      this.byPhone.set(next.contactPhone, next.id);
    }
    if (prev.contactEmail !== next.contactEmail) {
      this.byEmail.delete(prev.contactEmail);
      this.byEmail.set(next.contactEmail, next.id);
    }
    // org_slug is immutable — no maintenance needed.
  }
}

function errResult<T>(code: StoreError['code'], message: string): StoreResult<T> {
  return { ok: false, error: { code, message } as StoreError };
}
