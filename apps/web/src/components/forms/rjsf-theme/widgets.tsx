/**
 * The widget registry the RJSF theme passes to `Form`.
 *
 * @module apps/web/components/forms/rjsf-theme/widgets
 */
import type { RegistryWidgetsType, WidgetProps } from '@rjsf/utils';
import { ConsentCheckboxWidget } from '../ConsentCheckboxWidget';
import { LocationAutocompleteWidget } from '../custom-widgets/LocationAutocompleteWidget';
import { MultiLocationAutocompleteWidget } from '../custom-widgets/MultiLocationAutocompleteWidget';
import { ReferenceAutocompleteWidget } from '../custom-widgets/ReferenceAutocompleteWidget';
import { PhoneWidget } from '../custom-widgets/PhoneWidget';
import { CheckboxWidget, CheckboxesWidget, SelectWidget } from './choice-widgets';
import { CommaSeparatedArrayWidget, DateWidget, TextWidget, TextareaWidget } from './text-widgets';

/**
 * Widgets keyed by RJSF's default names and by the custom names the uiSchemas use.
 *
 * The other default widgets are aliased to `TextWidget` so `.bd-input` styling applies.
 */
export const widgets: RegistryWidgetsType = {
  TextWidget,
  // Custom widgets, keyed by the names the uiSchema uses. Same as the Signals profile form.
  'location-autocomplete': LocationAutocompleteWidget,
  'location-multi': MultiLocationAutocompleteWidget,
  'reference-autocomplete': ReferenceAutocompleteWidget,
  phone: PhoneWidget,
  TextareaWidget,
  SelectWidget,
  DateWidget,
  CheckboxWidget,
  CheckboxesWidget,
  CommaSeparatedArrayWidget,
  ConsentCheckbox: ConsentCheckboxWidget,
  // Native input type gives the right mobile keyboard and autofill.
  EmailWidget: (props: WidgetProps) => <TextWidget {...props} type="email" />,
  URLWidget: (props: WidgetProps) => <TextWidget {...props} type="url" />,
  UpDownWidget: TextWidget,
  RangeWidget: TextWidget,
  PasswordWidget: TextWidget,
  ColorWidget: TextWidget,
};
