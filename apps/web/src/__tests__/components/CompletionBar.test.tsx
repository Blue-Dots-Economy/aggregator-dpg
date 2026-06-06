import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CompletionBar } from '@/components/CompletionBar';

describe('<CompletionBar />', () => {
  it('renders an accessible progressbar with the given percent', () => {
    const { container } = render(<CompletionBar percent={42} />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar).toBeTruthy();
    expect(bar!.getAttribute('aria-valuenow')).toBe('42');
  });

  it('clamps percent above 100 to 100', () => {
    const { container } = render(<CompletionBar percent={150} />);
    expect(container.querySelector('[aria-valuenow="100"]')).toBeTruthy();
  });

  it('clamps negative percent to 0', () => {
    const { container } = render(<CompletionBar percent={-5} />);
    expect(container.querySelector('[aria-valuenow="0"]')).toBeTruthy();
  });

  it('rounds non-integer percents to the nearest integer', () => {
    const { container } = render(<CompletionBar percent={42.7} />);
    expect(container.querySelector('[aria-valuenow="43"]')).toBeTruthy();
  });
});
