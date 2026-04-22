/**
 * Public interface contract for this service package.
 *
 * All concrete implementations must extend ServiceBase. External packages
 * import exclusively from this subpath — never from src/in-memory/ or
 * any other internal path.
 *
 * @module @aggregator-dpg/_template/interface
 */

import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

/**
 * Example entity managed by this service.
 * Replace with your domain entity.
 */
export interface TemplateItem {
  id: string;
  name: string;
  createdAt: Date;
}

/**
 * Abstract base class for the template service.
 *
 * Concrete implementations (in-memory fake, real client) must extend this
 * class and implement every method with the exact same signature.
 */
export abstract class ServiceBase {
  /**
   * Retrieves an item by its ID.
   *
   * @param id - The item identifier.
   * @returns Ok with the item, or Err if not found or upstream fails.
   */
  abstract findById(id: string): Promise<Result<TemplateItem, BaseError>>;

  /**
   * Persists a new item.
   *
   * @param item - The item to save.
   * @returns Ok with the saved item, or Err on failure.
   */
  abstract save(item: Omit<TemplateItem, 'createdAt'>): Promise<Result<TemplateItem, BaseError>>;

  /**
   * Removes an item by its ID.
   *
   * @param id - The item identifier.
   * @returns Ok with void on success, or Err if not found.
   */
  abstract delete(id: string): Promise<Result<void, BaseError>>;
}
