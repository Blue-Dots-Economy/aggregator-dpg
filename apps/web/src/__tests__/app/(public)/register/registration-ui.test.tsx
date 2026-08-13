/**
 * Unit tests for the shared registration presentational pieces:
 * `useRegistrationFormState`, `RegistrationSubmitButton`,
 * `RegistrationErrorBanner`, and `RegistrationSuccessPanel`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, renderHook, act } from '@testing-library/react';
import {
  useRegistrationFormState,
  RegistrationSubmitButton,
  RegistrationErrorBanner,
  RegistrationSuccessPanel,
} from '@/app/(public)/register/registration-ui';

describe('useRegistrationFormState', () => {
  it('starts idle, not submittable', () => {
    const { result } = renderHook(() => useRegistrationFormState());
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.canSubmit).toBe(false);
  });

  it('updates state and canSubmit via the setters', () => {
    const { result } = renderHook(() => useRegistrationFormState());
    act(() => {
      result.current.setCanSubmit(true);
      result.current.setState({ status: 'submitting' });
    });
    expect(result.current.canSubmit).toBe(true);
    expect(result.current.state).toEqual({ status: 'submitting' });
  });

  it('focuses and scrolls the error ref when state transitions to error', () => {
    const { result, rerender } = renderHook(() => useRegistrationFormState());
    // Attach a real DOM node to the ref so the effect has something to act on.
    const div = document.createElement('div');
    div.scrollIntoView = () => {};
    Object.defineProperty(result.current.errorRef, 'current', { value: div, writable: true });
    act(() => {
      result.current.setState({
        status: 'error',
        title: 'Oops',
        detail: 'bad',
        code: 'X',
        requestId: 'r',
      });
    });
    rerender();
    expect(result.current.state.status).toBe('error');
  });
});

describe('RegistrationSubmitButton', () => {
  it('renders the idle label when not submitting', () => {
    render(
      <RegistrationSubmitButton
        submitting={false}
        canSubmit={true}
        label="Submit"
        submittingLabel="Submitting…"
      />,
    );
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
  });

  it('renders the submitting label and disables the button while submitting', () => {
    render(
      <RegistrationSubmitButton
        submitting={true}
        canSubmit={true}
        label="Submit"
        submittingLabel="Submitting…"
      />,
    );
    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
  });

  it('disables the button when canSubmit is false', () => {
    render(
      <RegistrationSubmitButton
        submitting={false}
        canSubmit={false}
        label="Submit"
        submittingLabel="Submitting…"
      />,
    );
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
  });
});

describe('RegistrationErrorBanner', () => {
  it('renders the title and each detail line as a bullet', () => {
    render(
      <RegistrationErrorBanner
        title="Submission failed"
        detail={'Name is required\nEmail is invalid'}
        errorRef={{ current: null }}
      />,
    );
    expect(screen.getByText('Submission failed')).toBeInTheDocument();
    expect(screen.getByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('Email is invalid')).toBeInTheDocument();
  });

  it('renders nothing extra when detail is empty', () => {
    render(<RegistrationErrorBanner title="Failed" detail="" errorRef={{ current: null }} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders the raw-errors details block when rawErrors is provided', () => {
    render(
      <RegistrationErrorBanner
        title="Failed"
        detail="bad"
        errorRef={{ current: null }}
        rawErrors={'[{"message":"bad"}]'}
      />,
    );
    expect(screen.getByText('Show raw validation errors')).toBeInTheDocument();
    expect(screen.getByText(/"message":"bad"/)).toBeInTheDocument();
  });
});

describe('RegistrationSuccessPanel', () => {
  it('renders heading, ref id, and message, with a link back to sign in', () => {
    render(
      <RegistrationSuccessPanel
        heading="Registration received"
        refLabel="Reference ID:"
        refId="agg-123"
        message="We will review your submission."
      />,
    );
    expect(screen.getByText('Registration received')).toBeInTheDocument();
    expect(screen.getByText('agg-123')).toBeInTheDocument();
    expect(screen.getByText('We will review your submission.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to sign in/i })).toHaveAttribute(
      'href',
      '/login',
    );
  });
});
