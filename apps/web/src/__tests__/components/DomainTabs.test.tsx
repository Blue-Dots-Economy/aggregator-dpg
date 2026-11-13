import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../i18n/messages/en.json';
import { DomainTabs } from '../../components/ui/DomainTabs';
import type { AggregatorConfigDomain } from '../../hooks/useAggregatorConfig';

const domain = (id: string, plural_label: string): AggregatorConfigDomain => ({
  id,
  label: id,
  plural_label,
  item_type: `${id}_profile_1.0`,
});

const THREE = [
  domain('seeker', 'Seekers'),
  domain('provider', 'Providers'),
  domain('mentor', 'Mentors'),
];

function renderTabs(props: Partial<Parameters<typeof DomainTabs>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DomainTabs domains={THREE} value="seeker" onChange={onChange} {...props} />
    </NextIntlClientProvider>,
  );
  return onChange;
}

describe('<DomainTabs />', () => {
  it('renders nothing for a single domain', () => {
    renderTabs({ domains: [domain('seeker', 'Seekers')] });
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('marks the selected tab and keeps only it in the tab order', () => {
    renderTabs({ value: 'provider' });
    const selected = screen.getByRole('tab', { selected: true });
    expect(selected).toHaveTextContent('Providers');
    expect(selected).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Seekers' })).toHaveAttribute('tabindex', '-1');
  });

  it('reports the clicked domain', () => {
    const onChange = renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: 'Mentors' }));
    expect(onChange).toHaveBeenCalledWith('mentor');
  });

  it.each([
    ['ArrowLeft', 'mentor'],
    ['ArrowRight', 'provider'],
    ['Home', 'seeker'],
    ['End', 'mentor'],
  ])('moves with %s', (key, expected) => {
    const onChange = renderTabs();
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key });
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it('ignores other keys', () => {
    const onChange = renderTabs();
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows a formatted count only for domains that have one', () => {
    renderTabs({ counts: { seeker: 1280, provider: 0 } });
    expect(screen.getByRole('tab', { name: 'Seekers 1,280' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Providers 0' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Mentors' })).toBeInTheDocument();
  });
});
