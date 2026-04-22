/**
 * In-memory implementation of ServiceBase for local development and testing.
 *
 * Not for production use. Stores all data in a Map — state is lost on restart.
 *
 * @module @aggregator-dpg/_template/in-memory
 */

import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { DomainError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { TemplateItem } from '../interface.js';
import { ServiceBase } from '../interface.js';

export class InMemoryService extends ServiceBase {
  protected readonly store = new Map<string, TemplateItem>();

  async findById(id: string): Promise<Result<TemplateItem, BaseError>> {
    const item = this.store.get(id);
    if (item === undefined) {
      return err(new DomainError(`Item not found: ${id}`, { code: 'NOT_FOUND' }));
    }
    return ok(item);
  }

  async save(input: Omit<TemplateItem, 'createdAt'>): Promise<Result<TemplateItem, BaseError>> {
    const item: TemplateItem = { ...input, createdAt: new Date() };
    this.store.set(item.id, item);
    return ok(item);
  }

  async delete(id: string): Promise<Result<void, BaseError>> {
    if (!this.store.has(id)) {
      return err(new DomainError(`Item not found: ${id}`, { code: 'NOT_FOUND' }));
    }
    this.store.delete(id);
    return ok(undefined);
  }
}
