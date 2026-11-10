import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { DomainSelect } from '@/components/ui/DomainSelect';

const SEEKER = { id: 'seeker', label: 'Seeker', plural_label: 'Seekers', item_type: 'profile_1.0' };
const PROVIDER = {
  id: 'provider',
  label: 'Provider',
  plural_label: 'Providers',
  item_type: 'job_posting_1.0',
};

function renderSelect(domains: (typeof SEEKER)[], onChange = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DomainSelect domains={domains} value="seeker" onChange={onChange} />
    </NextIntlClientProvider>,
  );
  return onChange;
}

// jsdom lacks the pointer-capture and scrollIntoView APIs Radix Select calls.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe('<DomainSelect />', () => {
  it('renders nothing for a single domain', () => {
    renderSelect([SEEKER]);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows the selected domain on the styled trigger', () => {
    renderSelect([SEEKER, PROVIDER]);
    expect(screen.getByRole('combobox', { name: 'Profile Type' })).toHaveTextContent('Seekers');
  });

  it('lists every domain by its plural label and reports the chosen one', async () => {
    const onChange = renderSelect([SEEKER, PROVIDER]);
    fireEvent.click(screen.getByRole('combobox', { name: 'Profile Type' }));
    expect(await screen.findByRole('option', { name: 'Seekers' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('option', { name: 'Providers' }));
    expect(onChange).toHaveBeenCalledWith('provider');
  });
});
