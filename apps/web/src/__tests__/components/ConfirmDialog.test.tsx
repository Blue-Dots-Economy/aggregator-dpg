/**
 * Unit tests for ConfirmDialog.
 *
 * Covers: closed renders nothing, focus moves to the confirm button on open,
 * Escape and Cancel call `onCancel`, Tab wraps inside the dialog, and focus
 * returns to the element that had it once the dialog closes.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

function dialog(open: boolean, onCancel = vi.fn(), onConfirm = vi.fn()) {
  return (
    <>
      <button type="button">Opener</button>
      <ConfirmDialog
        open={open}
        title="Remove member?"
        body="They lose access."
        confirmLabel="Remove"
        cancelLabel="Keep"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </>
  );
}

describe('<ConfirmDialog />', () => {
  it('renders nothing while closed', () => {
    render(dialog(false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('focuses the confirm button when it opens', () => {
    render(dialog(true));
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveFocus();
  });

  it('calls onCancel on Escape and on the cancel button', () => {
    const onCancel = vi.fn();
    render(dialog(true, onCancel));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('wraps Tab from the last button to the first', () => {
    render(dialog(true));
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus();
  });

  it('returns focus to the element that had it when it closes', () => {
    const { rerender } = render(dialog(false));
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    rerender(dialog(true));
    expect(opener).not.toHaveFocus();
    rerender(dialog(false));
    expect(opener).toHaveFocus();
  });
});
