/**
 * In-memory aggregator store.
 *
 * Process-local Map, suitable for unit tests. Mirrors the Postgres adapter's
 * external behaviour (unique slug, primary key on id).
 */

import { randomUUID } from 'node:crypto';
import {
  AggregatorStoreBase,
  type Aggregator,
  type CreateAggregatorInput,
  type StoreResult,
} from './interface.js';

export class InMemoryAggregatorStore extends AggregatorStoreBase {
  protected readonly byId = new Map<string, Aggregator>();
  protected readonly bySlug = new Map<string, string>();

  async create(input: CreateAggregatorInput): Promise<StoreResult<Aggregator>> {
    if (this.bySlug.has(input.orgSlug)) {
      return {
        ok: false,
        error: { code: 'DUPLICATE_SLUG', message: `slug already exists: ${input.orgSlug}` },
      };
    }
    const now = new Date();
    const row: Aggregator = {
      id: randomUUID(),
      orgSlug: input.orgSlug,
      type: input.type,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(row.id, row);
    this.bySlug.set(row.orgSlug, row.id);
    return { ok: true, value: row };
  }

  async findById(id: string): Promise<StoreResult<Aggregator | null>> {
    return { ok: true, value: this.byId.get(id) ?? null };
  }

  async findBySlug(orgSlug: string): Promise<StoreResult<Aggregator | null>> {
    const id = this.bySlug.get(orgSlug);
    return { ok: true, value: id ? (this.byId.get(id) ?? null) : null };
  }

  async deleteById(id: string): Promise<StoreResult<void>> {
    const row = this.byId.get(id);
    if (!row) return { ok: false, error: { code: 'NOT_FOUND', message: id } };
    this.byId.delete(id);
    this.bySlug.delete(row.orgSlug);
    return { ok: true, value: undefined };
  }
}
