/**
 * Component test for <PhoneInput />: the country code is fixed to +91 (the only
 * listed country) and the number box stops at the length that country allows.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import messages from '@/i18n/messages/en.json';
import { PhoneInput } from '@/components/forms/PhoneInput';
import { FormRuntimeConfigProvider } from '@/lib/FormRuntimeConfigProvider';

function Harness({
  onValue,
  nationalOnly = false,
  phoneCountries,
}: Readonly<{
  onValue: (v: string | undefined) => void;
  nationalOnly?: boolean;
  phoneCountries?: string;
}>) {
  const [value, setValue] = useState<string | undefined>(undefined);
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <FormRuntimeConfigProvider
        value={{ collegeDataset: 'ka', ...(phoneCountries ? { phoneCountries } : {}) }}
      >
        <PhoneInput
          id="p"
          aria-label="Phone"
          nationalOnly={nationalOnly}
          value={value}
          onChange={(v) => {
            setValue(v);
            onValue(v);
          }}
        />
      </FormRuntimeConfigProvider>
    </NextIntlClientProvider>
  );
}

describe('<PhoneInput />', () => {
  it('starts at +91 and keeps only 10 digits for India', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    expect(screen.getByLabelText('Country code')).toHaveTextContent('+91');
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '4567895678956789' } });
    expect(screen.getByLabelText('Phone')).toHaveValue('4567895678');
    expect(onValue).toHaveBeenLastCalledWith('+914567895678');
  });

  it('offers no way to type or change the country code', () => {
    render(<Harness onValue={vi.fn()} />);
    expect(screen.getByLabelText('Country code').tagName).toBe('SPAN');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('gives the code a fixed width so the number box keeps the rest of the row', () => {
    render(<Harness onValue={vi.fn()} />);
    const code = screen.getByLabelText('Country code');
    expect(code.style.width).toBe('6rem');
    expect(code.style.flexShrink).toBe('0');
  });

  it('keeps every digit of a pasted number with an unlisted code, so it fails validation', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.paste(screen.getByLabelText('Phone'), {
      clipboardData: { getData: () => '+61 412 345 678' },
    });
    expect(onValue).toHaveBeenLastCalledWith('+9161412345678');
  });

  it('stores only the 10 digits when the field takes no country code', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} nationalOnly />);
    expect(screen.getByLabelText('Country code')).toHaveTextContent('+91');
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '9876543210' } });
    expect(onValue).toHaveBeenLastCalledWith('9876543210');
  });

  it('reads a pasted full number instead of cutting it into a different one', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.paste(screen.getByLabelText('Phone'), {
      clipboardData: { getData: () => '+91 98765 43210' },
    });
    expect(onValue).toHaveBeenLastCalledWith('+919876543210');
  });

  it('offers a list starting at the first configured country when more than one is set', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} phoneCountries="GB:+44,IN:+91" />);
    const code = screen.getByLabelText('Country code');
    expect(code.tagName).toBe('SELECT');
    expect(code).toHaveValue('+44');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['🇬🇧 +44', '🇮🇳 +91']);
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '7911123456' } });
    expect(onValue).toHaveBeenLastCalledWith('+447911123456');
  });

  it('shows a single configured country as fixed text', () => {
    render(<Harness onValue={vi.fn()} phoneCountries="GB:+44" />);
    const code = screen.getByLabelText('Country code');
    expect(code.tagName).toBe('SPAN');
    expect(code).toHaveTextContent('+44');
  });
});
