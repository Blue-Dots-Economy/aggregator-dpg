/**
 * Unit + component tests: a server field error clears when its own field is
 * edited, and only then.
 */
import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import type { ErrorSchema, RJSFSchema } from '@rjsf/utils';
import messages from '@/i18n/messages/en.json';
import { RjsfThemedForm } from '@/components/forms/RjsfThemed';
import { useFieldErrors } from '@/components/forms/useFieldErrors';

const schema: RJSFSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    contact: {
      type: 'object',
      title: 'Contact',
      properties: { email: { type: 'string', title: 'Email' } },
    },
  },
};

const SERVER = { field_errors: { name: 'Name is taken.', 'contact.email': 'Email is taken.' } };
const BEFORE = { name: 'Asha', contact: { email: 'a@x.in' } };

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

function withServerErrors() {
  const hook = renderHook(() => useFieldErrors(schema), { wrapper });
  act(() => {
    hook.result.current.setServerErrors(SERVER);
  });
  return hook;
}

function marked(errors: ErrorSchema | undefined): string[] {
  const nameErrors = errors?.['name']?.__errors ?? [];
  const emailErrors = errors?.['contact']?.['email']?.__errors ?? [];
  return [...(nameErrors.length ? ['name'] : []), ...(emailErrors.length ? ['contact.email'] : [])];
}

describe('useFieldErrors onFormChange', () => {
  it('clears only the edited field and keeps the other', () => {
    const { result } = withServerErrors();
    expect(marked(result.current.formProps.extraErrors)).toEqual(['name', 'contact.email']);
    act(() => {
      result.current.onFormChange('root_name', {
        before: BEFORE,
        after: { ...BEFORE, name: 'Ash' },
      });
    });
    expect(marked(result.current.formProps.extraErrors)).toEqual(['contact.email']);
  });

  it('clears a nested field by its RJSF id', () => {
    const { result } = withServerErrors();
    act(() => {
      result.current.onFormChange('root_contact_email', {
        before: BEFORE,
        after: { ...BEFORE, contact: { email: 'b@x.in' } },
      });
    });
    expect(marked(result.current.formProps.extraErrors)).toEqual(['name']);
  });

  it('clears nothing for a change with no field id', () => {
    const { result } = withServerErrors();
    act(() => {
      result.current.onFormChange(undefined, { before: BEFORE, after: { ...BEFORE, name: 'X' } });
    });
    expect(marked(result.current.formProps.extraErrors)).toEqual(['name', 'contact.email']);
  });

  it('keeps the error when the field value did not change (a blur)', () => {
    const { result } = withServerErrors();
    act(() => {
      result.current.onFormChange('root_name', { before: BEFORE, after: { ...BEFORE } });
    });
    expect(marked(result.current.formProps.extraErrors)).toEqual(['name', 'contact.email']);
  });
});

function ServerErrorForm() {
  const fieldErrors = useFieldErrors(schema);
  const [data, setData] = useState<Record<string, unknown>>(BEFORE);
  return (
    <>
      <button type="button" onClick={() => fieldErrors.setServerErrors(SERVER)}>
        Fail
      </button>
      <RjsfThemedForm
        schema={schema}
        formData={data}
        {...fieldErrors.formProps}
        onChange={(e, id) => {
          fieldErrors.onFormChange(id, { before: data, after: e.formData });
          setData(e.formData ?? {});
        }}
      />
    </>
  );
}

function field(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`${id} not rendered`);
  return el;
}

describe('<RjsfThemedForm /> server errors', () => {
  function renderFailed() {
    render(<ServerErrorForm />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Fail' }));
    expect(screen.getByText(/Name is taken/)).toBeInTheDocument();
    expect(screen.getByText(/Email is taken/)).toBeInTheDocument();
  }

  it('typing in the nested email clears its error and keeps the name error', () => {
    renderFailed();
    fireEvent.change(field('root_contact_email'), {
      target: { value: 'b@x.in' },
    });
    expect(screen.queryByText(/Email is taken/)).not.toBeInTheDocument();
    expect(screen.getByText(/Name is taken/)).toBeInTheDocument();
  });

  it('leaving a field without editing it keeps its error', () => {
    renderFailed();
    const name = field('root_name');
    fireEvent.focus(name);
    fireEvent.blur(name);
    expect(screen.getByText(/Name is taken/)).toBeInTheDocument();
  });
});
