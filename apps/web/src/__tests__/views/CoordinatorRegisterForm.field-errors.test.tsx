/**
 * View test: <CoordinatorRegisterForm /> with the REAL RJSF form and the
 * repository's default coordinator schema, checking the form standard:
 * Submit is never disabled by a bad field, a click shows each field's message
 * with the schema's example, a wrong value shows when the field is left, and
 * a server 400 lands on its field. The address block is dropped; its widget
 * needs map configuration this test does not cover.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RJSFSchema } from '@rjsf/utils';
import messages from '@/i18n/messages/en.json';
import defaultSchema from '../../../../../config/schemas/aggregator/registration.v1.json';
import defaultUi from '../../../../../config/schemas/aggregator/registration.v1.ui.json';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

const gate = vi.fn();
vi.mock('@/components/consent/ConsentGate', () => ({
  ConsentGate: (props: { open: boolean; onAccept: () => void }) => {
    if (props.open) gate(props.onAccept);
    return null;
  },
}));

import { CoordinatorRegisterForm } from '@/app/(public)/register/CoordinatorRegisterForm';

const CONSENT = {
  terms: { version: 1, title: 'Terms of Service', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: 'Privacy body' },
};

const PHONE_REQUIRED = 'Phone is required.';
const PHONE_INVALID = 'Invalid entry. Please enter a valid Phone.';

/** Renders the default schema without `locations`, and without `type` when `noType` is set. */
function renderForm(noType = false) {
  const schema = structuredClone(defaultSchema) as unknown as Record<string, unknown>;
  delete (schema['properties'] as Record<string, unknown>)['locations'];
  if (noType) {
    delete (schema['properties'] as Record<string, unknown>)['type'];
    schema['required'] = (schema['required'] as string[]).filter((k) => k !== 'type');
  }
  const ui = structuredClone(defaultUi) as Record<string, unknown>;
  ui['ui:order'] = (ui['ui:order'] as string[]).filter((k) => k !== 'locations');
  delete ui['locations'];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['active-orgs'], {
    orgs: [{ id: 'd', slug: 'default', display_name: 'Default' }],
  });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <CoordinatorRegisterForm
          schema={schema as unknown as RJSFSchema}
          uiSchema={ui}
          consentContent={CONSENT}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const submit = () => screen.getByRole('button', { name: messages.register.submit });
const phone = () => screen.getByLabelText(/^Phone/);

function fillValid() {
  fireEvent.change(screen.getByLabelText(/Organisation Name/), {
    target: { value: 'Enable India' },
  });
  fireEvent.change(screen.getByLabelText(/Contact Name/), { target: { value: 'Rajesh Kumar' } });
  fireEvent.change(phone(), { target: { value: '9876543210' } });
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'a@enable.org' } });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  gate.mockClear();
  globalThis.fetch = originalFetch;
});

describe('<CoordinatorRegisterForm /> field errors', () => {
  it('keeps Submit enabled on an empty form', async () => {
    renderForm();
    await screen.findByText('Default');
    expect(submit()).toBeEnabled();
  });

  it('on Submit, says each empty field is required under its box, with no example', async () => {
    renderForm();
    await screen.findByText('Default');
    fireEvent.click(submit());
    const msg = await screen.findByText(PHONE_REQUIRED);
    expect(msg.closest('#root_contact_phone__error')).not.toBeNull();
    expect(phone()).toHaveAttribute('aria-invalid', 'true');
    expect(phone()).toHaveAttribute('aria-describedby', 'root_contact_phone__error');
    expect(phone().getAttribute('placeholder') ?? '').not.toContain('required');
    expect(screen.queryByText(/is required\. Example/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(gate).not.toHaveBeenCalled();
  });

  it('shows "Invalid entry" under the box for a wrong value, with no example', async () => {
    renderForm();
    await screen.findByText('Default');
    fireEvent.change(phone(), { target: { value: '12345' } });
    fireEvent.click(submit());
    expect(await screen.findByText(PHONE_INVALID)).toBeInTheDocument();
  });

  it('shows the organisation message under the picker', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['active-orgs'], {
      orgs: [
        { id: 'a', slug: 'a', display_name: 'Org A' },
        { id: 'b', slug: 'b', display_name: 'Org B' },
      ],
    });
    render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={messages}>
          <CoordinatorRegisterForm
            schema={{ type: 'object', properties: {} }}
            uiSchema={{}}
            consentContent={CONSENT}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(submit());
    const msg = await screen.findByText(messages.register.org_selector_required);
    expect(msg).toHaveAttribute('id', 'coordinator-org__error');
    expect(msg.closest('.sr-only')).toBeNull();
  });

  it('marks the empty Aggregator Type dropdown invalid after Submit', async () => {
    renderForm();
    await screen.findByText('Default');
    fireEvent.click(submit());
    const type = screen.getByRole('combobox', { name: /Aggregator Type/ });
    await waitFor(() => expect(type).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText('Aggregator Type is required.')).toBeInTheDocument();
    expect(type).not.toHaveTextContent('required');
  });

  it('shows a wrong value when the field is left, without flagging untouched fields', async () => {
    renderForm();
    await screen.findByText('Default');
    fireEvent.change(phone(), { target: { value: '12345' } });
    fireEvent.blur(phone());
    expect(await screen.findByText(PHONE_INVALID)).toBeInTheDocument();
    expect(screen.queryByText(/Email is required/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears a field message once it is fixed after a Submit', async () => {
    renderForm();
    await screen.findByText('Default');
    fireEvent.click(submit());
    await waitFor(() => expect(phone()).toHaveAttribute('aria-invalid', 'true'));
    fireEvent.change(phone(), { target: { value: '9876543210' } });
    await waitFor(() => expect(phone()).not.toHaveAttribute('aria-invalid'));
    expect(screen.queryByText(PHONE_REQUIRED)).toBeNull();
  });

  it('shows a server 400 on the field it names and keeps what was typed', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION',
              title: 'Invalid registration',
              detail: 'Payload failed JSON Schema validation.',
              fields: {
                issues: [{ keyword: 'pattern', instancePath: '/contact/phone', params: {} }],
              },
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    renderForm(true);
    await screen.findByText('Default');
    fillValid();
    fireEvent.click(submit());
    await waitFor(() => expect(gate).toHaveBeenCalled());
    const accept = gate.mock.calls.at(-1)![0] as () => Promise<void>;
    await accept();
    expect(await screen.findAllByText(PHONE_INVALID)).not.toHaveLength(0);
    expect(screen.queryByText('Payload failed JSON Schema validation.')).toBeNull();
    expect(phone()).toHaveValue('9876543210');
  });
});
