import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';

describe('<SegmentedTabs />', () => {
  it('marks the active tab and fires onChange on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SegmentedTabs
        value="a"
        onChange={onChange}
        items={[
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
        ]}
      />,
    );
    const alpha = screen.getByRole('button', { name: 'Alpha' });
    const beta = screen.getByRole('button', { name: 'Beta' });
    expect(alpha).toHaveClass('active');
    expect(beta).not.toHaveClass('active');
    await user.click(beta);
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
