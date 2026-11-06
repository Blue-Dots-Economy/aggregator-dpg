/**
 * The RJSF theme's object template: a titled grid or stack of child fields.
 *
 * @module apps/web/components/forms/rjsf-theme/ObjectFieldTemplate
 */
import type { ReactElement } from 'react';
import type { ObjectFieldTemplateProps } from '@rjsf/utils';
import { isRecord } from '../is-record';
import { SectionedObject, readFormLayout } from './SectionedObject';

/**
 * Reads the `uiSchema` off one of `ObjectFieldTemplate`'s child slots.
 *
 * React 19 types element `props` as `unknown`, so the shape is narrowed here.
 *
 * @param content - The rendered child field element.
 * @returns The child's `uiSchema`, or `undefined` when it carries none.
 */
function childUiSchema(content: ReactElement): Record<string, unknown> | undefined {
  const props: unknown = content.props;
  if (!isRecord(props)) return undefined;
  return isRecord(props.uiSchema) ? props.uiSchema : undefined;
}

/**
 * Renders an object's child fields.
 *
 * A root schema with `x-form-layout` renders as numbered sections. Otherwise
 * the fields sit in a two-column grid (`ui:layout: stack` gives one column),
 * under the object's title unless `ui:title` is empty or `false`.
 *
 * @param props - RJSF object template props.
 * @returns The object's fields.
 */
export function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const { properties, title, description, uiSchema, schema } = props;
  const uiLayout: unknown = uiSchema?.['ui:layout'];
  const layout = uiLayout ?? 'grid';
  // An empty or false `ui:title` hides the heading.
  const explicitTitle: unknown = uiSchema?.['ui:title'];
  const showTitle = explicitTitle !== '' && explicitTitle !== false && Boolean(title);
  // Skip hidden children so they leave no empty wrapper in the grid.
  const visibleProperties = properties.filter(
    (p) => childUiSchema(p.content)?.['ui:widget'] !== 'hidden',
  );

  // `x-form-layout` (root schema only) takes precedence over the flat grid.
  const formLayout = readFormLayout(schema);
  if (formLayout) {
    return <SectionedObject layout={formLayout} properties={visibleProperties} />;
  }

  return (
    <div className="space-y-3">
      {showTitle && (
        <div>
          <h3 className="font-display font-bold text-[15px] text-ink-900">{title}</h3>
          {description && <p className="text-[12.5px] text-ink-400 mt-0.5">{description}</p>}
        </div>
      )}
      <div
        className={
          layout === 'grid'
            ? 'grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-3'
            : 'flex flex-col gap-3'
        }
      >
        {visibleProperties.map((p) => {
          const wide = childUiSchema(p.content)?.['ui:colSpan'] === 2;
          return (
            <div key={p.name} className={wide ? 'md:col-span-2' : ''}>
              {p.content}
            </div>
          );
        })}
      </div>
    </div>
  );
}
