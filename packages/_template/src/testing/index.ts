/**
 * Test fake for ServiceBase — use this in unit tests instead of mocking.
 *
 * Extends the in-memory implementation with seed helpers so tests can
 * pre-populate state without going through the public API.
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

export type { TemplateItem } from '../interface.js';
export { ServiceBase } from '../interface.js';
