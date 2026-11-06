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
 * Items with the same derived key get a `#2`, `#3`, … suffix in list order,
 * skipping any key already taken, so every key in the result is unique.
 *
 * @param items - The list to render.
 * @param baseKey - Builds the key from an item's identifying fields.
 * @returns The items in the same order, each with its key.
 */
export function withStableKeys<T>(
  items: readonly T[],
  baseKey: (item: T) => string,
): KeyedItem<T>[] {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  return items.map((item) => {
    const base = baseKey(item);
    let suffix = nextSuffix.get(base) ?? 1;
    let key = suffix === 1 ? base : `${base}#${suffix}`;
    // Another item's own key can look like a suffixed one (`Unit#2`), so skip taken keys.
    while (used.has(key)) {
      suffix += 1;
      key = `${base}#${suffix}`;
    }
    nextSuffix.set(base, suffix + 1);
    used.add(key);
    return { item, key };
  });
}
