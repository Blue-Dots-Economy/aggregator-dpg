/**
 * Unit tests for the shared registration presentational pieces:
 * `useRegistrationFormState`, `RegistrationSubmitButton`,
 * and `RegistrationErrorBanner`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, renderHook, act, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { RjsfThemedForm } from '@/components/forms/RjsfThemed';
import { useFieldErrors } from '@/components/forms/useFieldErrors';
import {
  sharedRegistrationFormProps,
  useRegistrationFormState,
  showsErrorBanner,
  RegistrationSubmitButton,
  RegistrationErrorBanner,
} from '@/app/(public)/register/registration-ui';

describe('useRegistrationFormState', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useRegistrationFormState());
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  it('updates state via the setter', () => {
    const { result } = renderHook(() => useRegistrationFormState());
    act(() => {
      result.current.setState({ status: 'submitting' });
    });
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
  const base = {
    onAttempt: () => {},
    label: 'Submit',
    submittingLabel: 'Submitting…',
  };

  it('stays enabled when not submitting and reports the attempt on click', () => {
    const onAttempt = vi.fn();
    render(<RegistrationSubmitButton {...base} submitting={false} onAttempt={onAttempt} />);
    const button = screen.getByRole('button', { name: 'Submit' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onAttempt).toHaveBeenCalledOnce();
  });

  it('renders the submitting label and disables the button while submitting', () => {
    render(<RegistrationSubmitButton {...base} submitting={true} />);
    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
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
});

describe('showsErrorBanner', () => {
  const error = (code: string) =>
    ({ status: 'error', title: 't', detail: '', code, requestId: '' }) as const;

  it('shows it for errors with no field', () => {
    expect(showsErrorBanner(error('USER_EXISTS'))).toBe(true);
    expect(showsErrorBanner(error('CLIENT_VALIDATION'))).toBe(true);
    expect(showsErrorBanner({ status: 'idle' })).toBe(false);
  });
});

describe('person name check', () => {
  const schema = {
    type: 'object',
    properties: {
      owner: {
        type: 'object',
        title: 'Organisation Owner',
        properties: { name: { type: 'string', title: 'Owner Name' } },
      },
    },
  } as const;

  function Harness({
    name,
    onSubmit,
    customValidate,
  }: {
    name: string;
    onSubmit: () => void;
    customValidate?: Parameters<typeof sharedRegistrationFormProps>[0]['customValidate'];
  }) {
    const fieldErrors = useFieldErrors(schema as never);
    const props = sharedRegistrationFormProps({
      formData: { owner: { name } },
      setFormData: () => {},
      handleSubmit: onSubmit,
      fieldErrors,
      onLocationResolved: () => {},
      personName: { path: 'owner.name', message: (s) => `Remove: ${s}` },
      customValidate,
    });
    return (
      <RjsfThemedForm schema={schema as never} {...props}>
        {/* The real Submit button marks the attempt before RJSF validates. */}
        <button type="submit" onClick={fieldErrors.markAttempted}>
          Submit
        </button>
      </RjsfThemedForm>
    );
  }

  function renderWithName(
    name: string,
    customValidate?: Parameters<typeof sharedRegistrationFormProps>[0]['customValidate'],
  ) {
    const onSubmit = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Harness name={name} onSubmit={onSubmit} {...(customValidate ? { customValidate } : {})} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    return { onSubmit };
  }

  it('shows the refused symbols on the name field and does not submit', async () => {
    const { onSubmit } = renderWithName('Ravi Kumar (Ops)');
    expect(await screen.findByText(/Remove: \( \)/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("runs the form's own check and the name check together", async () => {
    const own = vi.fn((_data: unknown, errors: Parameters<NonNullable<typeof own>>[1]) => errors);
    renderWithName('Asha / QA', own as never);
    expect(own).toHaveBeenCalled();
    expect(await screen.findByText(/Remove: \//)).toBeInTheDocument();
  });

  it('submits an ordinary name', () => {
    const { onSubmit } = renderWithName("Ravi D'Souza");
    expect(onSubmit).toHaveBeenCalled();
  });
});
