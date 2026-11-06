/**
 * Component test for <PhoneInput />: the code box starts at +91 and can be
 * edited, and the number box stops at the length the code allows.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import messages from '@/i18n/messages/en.json';
import { PhoneInput } from '@/components/forms/PhoneInput';

function Harness({
  onValue,
  nationalOnly = false,
}: Readonly<{ onValue: (v: string | undefined) => void; nationalOnly?: boolean }>) {
  const [value, setValue] = useState<string | undefined>(undefined);
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
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
    </NextIntlClientProvider>
  );
}

describe('<PhoneInput />', () => {
  it('starts at +91 and keeps only 10 digits for India', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    expect(screen.getByLabelText('Country code')).toHaveValue('+91');
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '4567895678956789' } });
    expect(screen.getByLabelText('Phone')).toHaveValue('4567895678');
    expect(onValue).toHaveBeenLastCalledWith('+914567895678');
  });

  it('lets the user type another country code', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('Country code'), { target: { value: '+44' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '7911123456' } });
    expect(onValue).toHaveBeenLastCalledWith('+447911123456');
    expect(screen.getByLabelText('Country code')).toHaveValue('+44');
  });

  it('stores only the 10 digits when the field takes no country code', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} nationalOnly />);
    expect(screen.getByLabelText('Country code')).toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '9876543210' } });
    expect(onValue).toHaveBeenLastCalledWith('9876543210');
  });

  it('never saves a number under an emptied code box', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '9876543210' } });
    fireEvent.change(screen.getByLabelText('Country code'), { target: { value: '' } });
    expect(onValue).toHaveBeenLastCalledWith('+919876543210');
    fireEvent.blur(screen.getByLabelText('Country code'));
    expect(screen.getByLabelText('Country code')).toHaveValue('+91');
  });

  it('reads a pasted full number instead of cutting it into a different one', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.paste(screen.getByLabelText('Phone'), {
      clipboardData: { getData: () => '+91 98765 43210' },
    });
    expect(onValue).toHaveBeenLastCalledWith('+919876543210');
  });
});
