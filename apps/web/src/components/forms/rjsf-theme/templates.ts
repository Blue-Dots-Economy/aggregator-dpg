/**
 * The template set the RJSF theme passes to `Form`.
 *
 * @module apps/web/components/forms/rjsf-theme/templates
 */
import type { TemplatesType } from '@rjsf/utils';
import { ArrayFieldItemTemplate, ArrayFieldTemplate } from './array-templates';
import { FieldTemplate } from './FieldTemplate';
import { ObjectFieldTemplate } from './ObjectFieldTemplate';

/** Renders nothing: the object and array templates draw their own titles. */
function TitleField() {
  return null;
}

/** The theme's field, object, array and title templates. */
export const templates: Partial<TemplatesType> = {
  FieldTemplate,
  ObjectFieldTemplate,
  ArrayFieldTemplate,
  ArrayFieldItemTemplate,
  TitleFieldTemplate: TitleField,
};
