import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SelectField, type SelectFieldOption } from '@/components/ui/SelectField';
import { chooseOption } from '@/__tests__/test-utils';

const FRUIT: SelectFieldOption[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'pear', label: 'Pear', disabled: true },
  { value: 'plum', label: 'Plum' },
];

function renderField(props: Partial<Parameters<typeof SelectField>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <SelectField aria-label="Fruit" value="apple" onChange={onChange} options={FRUIT} {...props} />,
  );
  return onChange;
}

describe('<SelectField />', () => {
  it('shows the selected option on a styled trigger', () => {
    renderField();
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveTextContent('Apple');
  });

  it('reports the chosen value', async () => {
    const onChange = renderField();
    await chooseOption(screen.getByRole('combobox', { name: 'Fruit' }), 'Plum');
    expect(onChange).toHaveBeenCalledWith('plum');
  });

  it('marks a disabled option', async () => {
    renderField();
    fireEvent.click(screen.getByRole('combobox', { name: 'Fruit' }));
    expect(await screen.findByRole('option', { name: 'Pear' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows the placeholder while nothing is selected', () => {
    renderField({ value: '', placeholder: 'Pick a fruit' });
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveTextContent('Pick a fruit');
  });

  it('selects and reports an option whose value is empty', async () => {
    const onChange = renderField({
      value: '',
      options: [{ value: '', label: 'Any fruit' }, ...FRUIT],
    });
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    expect(trigger).toHaveTextContent('Any fruit');
    await chooseOption(trigger, 'Plum');
    expect(onChange).toHaveBeenLastCalledWith('plum');
  });

  it('reports an empty value when the empty option is chosen', async () => {
    const onChange = renderField({ options: [{ value: '', label: 'Any fruit' }, ...FRUIT] });
    await chooseOption(screen.getByRole('combobox', { name: 'Fruit' }), 'Any fruit');
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('passes the id, the icon and the disabled state to the trigger', () => {
    renderField({ id: 'fruit', disabled: true, icon: <svg data-testid="icon" /> });
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    expect(trigger).toHaveAttribute('id', 'fruit');
    expect(trigger).toBeDisabled();
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('submits its value under the given name', () => {
    const { container } = render(
      <form>
        <SelectField name="fruit" value="plum" onChange={vi.fn()} options={FRUIT} required />
      </form>,
    );
    expect(container.querySelector('select[name="fruit"]')).toHaveValue('plum');
  });
});
