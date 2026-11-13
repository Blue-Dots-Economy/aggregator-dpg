/**
 * Unit tests for PhoneWidget and withPhoneWidget.
 *
 * Covers: the fixed +91 code, digits only and at most 10, the stored
 * `+91…` value, reading back a stored value, an empty field clearing the
 * value, and the widget applied to nested `phone` fields only.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { WidgetProps } from '@rjsf/utils';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { PhoneWidget, localDigits } from '@/components/forms/custom-widgets/PhoneWidget';
import { withPhoneWidget } from '@/lib/phone-ui-schema';
import { FormRuntimeConfigProvider } from '@/lib/FormRuntimeConfigProvider';

function renderIt(
  value?: string,
  phoneCountries?: string,
  placeholder = '+91 98765 43210',
  extra: Partial<WidgetProps> = {},
) {
  const onChange = vi.fn();
  const props = {
    id: 'root_owner_phone',
    value,
    onChange,
    onBlur: vi.fn(),
    onFocus: vi.fn(),
    placeholder,
    rawErrors: [],
    ...extra,
  } as unknown as WidgetProps;
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <FormRuntimeConfigProvider
        value={{ collegeDataset: 'ka', ...(phoneCountries ? { phoneCountries } : {}) }}
      >
        <PhoneWidget {...props} />
      </FormRuntimeConfigProvider>
    </NextIntlClientProvider>,
  );
  // The number box; the country code box beside it is labelled separately.
  const input = document.getElementById('root_owner_phone');
  if (!(input instanceof HTMLInputElement)) throw new Error('number box not rendered');
  return { onChange, input };
}

describe('<PhoneWidget />', () => {
  it('stores a value saved in another layout as +91 and 10 digits', () => {
    const { onChange } = renderIt('+91 98765 43210');
    expect(onChange).toHaveBeenCalledWith('+919876543210');
  });

  it('does not rewrite a stored value when the field is read-only or disabled', () => {
    expect(
      renderIt('+91 98765 43210', undefined, '', { readonly: true }).onChange,
    ).not.toHaveBeenCalled();
    expect(
      renderIt('+91 98765 43210', undefined, '', { disabled: true }).onChange,
    ).not.toHaveBeenCalled();
  });

  it('leaves free text that is not a phone layout untouched', () => {
    const { onChange } = renderIt('call 98765 43210 after 6');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('tidies a number written with dots and brackets', () => {
    const { onChange } = renderIt('(+91) 98765.43210');
    expect(onChange).toHaveBeenCalledWith('+919876543210');
  });

  it('leaves a value already in its own layout alone', () => {
    const { onChange } = renderIt('+919876543210');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows +91 in front and the placeholder without it', () => {
    const { input } = renderIt();
    expect(screen.getByLabelText('Country code')).toHaveTextContent('+91');
    expect(input).toHaveAttribute('placeholder', '98765 43210');
    expect(input).toHaveAttribute('maxLength', '10');
    expect(input).toHaveAttribute('inputMode', 'numeric');
  });

  it('keeps digits only, at most 10, and stores +91 with them', () => {
    const { input, onChange } = renderIt();
    fireEvent.change(input, { target: { value: '98a76-543 21099' } });
    expect(onChange).toHaveBeenLastCalledWith('+919876543210');
  });

  it('clears the value when the field is emptied', () => {
    const { input, onChange } = renderIt('+919876543210');
    expect(input).toHaveValue('9876543210');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});

describe('<PhoneWidget /> with configured countries', () => {
  it('starts at the first configured country and drops its code from the placeholder', () => {
    const { input, onChange } = renderIt(undefined, 'GB:+44,IN:+91', '+44 7911 123456');
    expect(screen.getByLabelText('Country code')).toHaveValue('+44');
    expect(input).toHaveAttribute('placeholder', '7911 123456');
    fireEvent.change(input, { target: { value: '7911123456' } });
    expect(onChange).toHaveBeenLastCalledWith('+447911123456');
  });

  it('reads a stored number of a configured country back into its own code', () => {
    const { input, onChange } = renderIt('+44 7911 123456', 'IN:+91,GB:+44');
    expect(onChange).toHaveBeenCalledWith('+447911123456');
    expect(input).toHaveValue('7911123456');
  });
});

describe('localDigits', () => {
  it('reads the local part of stored values', () => {
    expect(localDigits('+919')).toBe('9');
    expect(localDigits('+919876543210')).toBe('9876543210');
    expect(localDigits('919876543210')).toBe('9876543210');
    expect(localDigits('9876543210')).toBe('9876543210');
    expect(localDigits(undefined)).toBe('');
  });
});

describe('withPhoneWidget', () => {
  const schema = {
    type: 'object',
    properties: {
      phone: { type: 'string' },
      owner: {
        type: 'object',
        properties: { phone: { type: 'string' }, name: { type: 'string' } },
      },
      contact: { type: 'object', properties: { phone: { type: 'string' } } },
    },
  };

  it('puts the phone widget on phone fields at any depth', () => {
    const ui = withPhoneWidget({ owner: { phone: { 'ui:placeholder': 'x' } } }, schema);
    expect(ui).toEqual({
      phone: { 'ui:widget': 'phone' },
      owner: { phone: { 'ui:placeholder': 'x', 'ui:widget': 'phone' } },
      contact: { phone: { 'ui:widget': 'phone' } },
    });
  });

  it('keeps a widget the uiSchema already picks', () => {
    const ui = withPhoneWidget({ phone: { 'ui:widget': 'hidden' } }, schema);
    expect(ui['phone']).toEqual({ 'ui:widget': 'hidden' });
  });
});
