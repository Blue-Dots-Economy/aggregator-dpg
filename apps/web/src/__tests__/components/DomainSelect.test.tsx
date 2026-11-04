import { describe, it, expect, vi } from 'vitest';
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

describe('<DomainSelect />', () => {
  it('renders nothing for a single domain', () => {
    renderSelect([SEEKER]);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('lists every domain by its plural label', () => {
    renderSelect([SEEKER, PROVIDER]);
    const select = screen.getByRole('combobox', { name: 'Domain' });
    expect(select).toHaveValue('seeker');
    expect(screen.getByRole('option', { name: 'Providers' })).toBeInTheDocument();
  });

  it('reports the chosen domain', () => {
    const onChange = renderSelect([SEEKER, PROVIDER]);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'provider' } });
    expect(onChange).toHaveBeenCalledWith('provider');
  });
});
