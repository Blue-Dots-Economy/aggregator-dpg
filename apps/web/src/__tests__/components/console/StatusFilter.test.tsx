/**
 * Unit tests for StatusFilter.
 *
 * Covers: the GET form wiring (method + action), the hidden pass-through
 * inputs, the status options, and the pre-selected value.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { StatusFilter } from '@/components/console/StatusFilter';

function renderFilter(props: Parameters<typeof StatusFilter>[0]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StatusFilter {...props} />
    </NextIntlClientProvider>,
  );
}

describe('<StatusFilter />', () => {
  it('renders a GET form pointing at the given action', () => {
    const { container } = renderFilter({ action: '/console/coordinators', value: '' });
    const form = container.querySelector('form')!;
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/console/coordinators');
  });

  it('renders every status option plus "all"', () => {
    renderFilter({ action: '/x', value: '' });
    expect(screen.getByRole('option', { name: messages.console.coordinators.all })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: messages.console.status.pending })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: messages.console.status.active })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: messages.console.status.inactive })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: messages.console.status.retired })).toBeInTheDocument();
  });

  it('pre-selects the current value', () => {
    renderFilter({ action: '/x', value: 'active' });
    expect(screen.getByRole('combobox')).toHaveValue('active');
  });

  it('emits hidden inputs for each pass-through field', () => {
    const { container } = renderFilter({
      action: '/x',
      value: '',
      hidden: { org: 'org-1', q: 'term' },
    });
    const hidden = Array.from(container.querySelectorAll('input[type="hidden"]'));
    expect(hidden).toHaveLength(2);
    expect(container.querySelector('input[name="org"]')).toHaveAttribute('value', 'org-1');
    expect(container.querySelector('input[name="q"]')).toHaveAttribute('value', 'term');
  });
});
