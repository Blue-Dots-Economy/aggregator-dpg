/**
 * Test fake for ServiceBase — use this in unit tests instead of mocking.
 *
 * Extends the in-memory implementation with seed helpers and a test data
 * builder so tests can pre-populate state without going through the public API.
 *
 * Import via the ./testing subpath — never import from src/testing directly.
 *
 * @module @aggregator-dpg/_template/testing
 */

import { InMemoryService } from '../in-memory/index.js';
import type { TemplateItem } from '../interface.js';

export class ServiceFake extends InMemoryService {
  /**
   * Seeds the fake with pre-built items for test setup.
   *
   * @param items - Items to insert before the test runs.
   */
  seed(items: TemplateItem[]): void {
    for (const item of items) {
      this.store.set(item.id, item);
    }
  }
}

/**
 * Builds a valid TemplateItem with deterministic defaults.
 *
 * Pass overrides to set only the fields your test cares about.
 *
 * @param overrides - Partial fields to override the defaults.
 * @returns A fully-formed TemplateItem ready to pass to seed().
 */
export function buildTemplateItem(overrides: Partial<TemplateItem> = {}): TemplateItem {
  return {
    id: 'item-default',
    name: 'Default Item',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
