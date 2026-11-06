/**
 * The RJSF theme's array templates: numbered items with Remove, and an
 * "Add another" button.
 *
 * @module apps/web/components/forms/rjsf-theme/array-templates
 */
import type { ArrayFieldItemTemplateProps, ArrayFieldTemplateProps, UiSchema } from '@rjsf/utils';

/** Item noun used when the array's uiSchema sets no `itemLabel`. */
const DEFAULT_ITEM_LABEL = 'entry';

/**
 * Reads the `itemLabel` ui option off an array field's own uiSchema.
 *
 * Used by both array templates; the item template passes `parentUiSchema`.
 *
 * @param uiSchema - The array field's uiSchema, if it declares one.
 * @returns The configured item noun, defaulting to `entry`.
 */
function arrayItemLabel(uiSchema: UiSchema | undefined): string {
  const itemLabel: unknown = uiSchema?.['ui:options']?.['itemLabel'];
  return typeof itemLabel === 'string' ? itemLabel : DEFAULT_ITEM_LABEL;
}

function capitalise(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * Renders one array item with an "<Item> N" heading and Remove button.
 *
 * The heading and button show only when the array has more than one entry.
 *
 * @param props - RJSF array item props.
 * @returns One array row, with its header when the array has several rows.
 */
export function ArrayFieldItemTemplate(props: ArrayFieldItemTemplateProps) {
  const { children, index, totalItems, buttonsProps, parentUiSchema } = props;
  const itemLabel = arrayItemLabel(parentUiSchema);
  const multiple = totalItems > 1;
  return (
    <div className="space-y-2">
      {multiple && (
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-semibold text-ink-500">
            {capitalise(itemLabel)} {index + 1}
          </span>
          {buttonsProps.hasRemove && (
            <button
              type="button"
              onClick={buttonsProps.onRemoveItem}
              className="text-[12.5px] text-rose-500 hover:text-rose-600"
            >
              Remove
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Renders an array's title, its items and an "Add another" button.
 *
 * @param props - RJSF array template props.
 * @returns The array field.
 */
export function ArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  const { title, items, canAdd, onAddClick, uiSchema } = props;
  const itemLabel = arrayItemLabel(uiSchema);
  return (
    <div className="space-y-3">
      {title && <h3 className="font-display font-bold text-[15px] text-ink-900">{title}</h3>}
      {/* Items arrive already rendered and keyed. */}
      {items}
      {canAdd && (
        <button
          type="button"
          onClick={onAddClick}
          className="inline-flex items-center gap-1.5 text-[13px] text-primary-600 hover:text-primary-700 font-semibold"
        >
          + Add another {itemLabel.toLowerCase()}
        </button>
      )}
    </div>
  );
}
