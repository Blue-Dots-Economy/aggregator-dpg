/**
 * React list keys built from an item's own fields (web app, `apps/web`).
 *
 * An index key moves to another item when the list is filtered, reordered or
 * has an item removed, so React reuses the wrong DOM node. These keys stay with
 * the item.
 *
 * @module apps/web/lib/list-keys
 */

/** One list item with the React key to render it under. */
export interface KeyedItem<T> {
  item: T;
  key: string;
}

/**
 * Pairs each item with a key derived from its own fields.
 *
 * Items with the same derived key get a `#2`, `#3`, … suffix in list order, so
 * every key in the result is unique.
 *
 * @param items - The list to render.
 * @param baseKey - Builds the key from an item's identifying fields.
 * @returns The items in the same order, each with its key.
 */
export function withStableKeys<T>(
  items: readonly T[],
  baseKey: (item: T) => string,
): KeyedItem<T>[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = baseKey(item);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { item, key: count === 1 ? base : `${base}#${count}` };
  });
}
