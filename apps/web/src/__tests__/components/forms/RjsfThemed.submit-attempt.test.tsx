/**
 * Component test: a submit from the Enter key counts as an attempt, so a form
 * with a missing required field shows the message and does not submit.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { RJSFSchema } from '@rjsf/utils';
import messages from '@/i18n/messages/en.json';
import { RjsfThemedForm } from '@/components/forms/RjsfThemed';
import { useFieldErrors } from '@/components/forms/useFieldErrors';

const schema: RJSFSchema = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', title: 'Name' } },
};

function NameForm({ onSubmit }: Readonly<{ onSubmit: () => void }>) {
  const fieldErrors = useFieldErrors(schema);
  return <RjsfThemedForm schema={schema} {...fieldErrors.formProps} onSubmit={onSubmit} />;
}

describe('<RjsfThemedForm /> submit attempt', () => {
  it('blocks an Enter-key submit of an empty required field and says it is required', () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <NameForm onSubmit={onSubmit} />
      </NextIntlClientProvider>,
    );
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    if (form) fireEvent.submit(form);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Name is required.')).toBeInTheDocument();
  });
});
