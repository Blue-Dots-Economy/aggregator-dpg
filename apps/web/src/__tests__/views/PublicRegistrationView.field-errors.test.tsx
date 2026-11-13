/**
 * View test: <PublicRegistrationView /> tells the participant which field is
 * wrong (#903).
 *
 * Renders the REAL RJSF form (no shim): the defect lived in the interplay
 * between RJSF's validity, the disabled Submit button and the deferred error
 * display, which a shim would hide. Covers:
 *  - Submit is never disabled by an invalid field; clicking it shows the
 *    field's error under the field, with no banner or summary.
 *  - The message is readable ("Invalid entry. Please enter a valid web address."), never a regex.
 *  - A field the server rejects (`error.fields.field_errors`) is marked inline, with no banner.
 *  - A non-field failure shows one readable banner and keeps the input.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';
import { URL_PATTERN } from '@aggregator-dpg/network-config/uri-fields';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({
    data: {
      brand: { short_name: 'Blue Dots', primary_color: '#2563EB' },
      domains: [{ id: 'seeker', label: 'Seeker' }],
    },
    isError: false,
  }),
  DEFAULT_AGGREGATOR_CONFIG: { brand: { short_name: 'Blue Dots' }, domains: [] },
}));

import {
  PublicRegistrationView,
  readableFormErrors,
} from '@/app/[org]/[slug]/PublicRegistrationView';

/** The schema as the API serves it: link fields already carry the URL rule. */
const SCHEMA = {
  type: 'object',
  required: ['name', 'phone'],
  properties: {
    name: { type: 'string', title: 'Name' },
    phone: { type: 'string', title: 'Mobile' },
    website: { type: 'string', title: 'Website', 'x-uri': true, pattern: URL_PATTERN },
  },
};

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <PublicRegistrationView
          org="acme"
          slug="winter25"
          domain="seeker"
          context={{ title: 'Winter 2025 Registration', org_name: 'Acme' }}
          schema={SCHEMA}
          uiSchema={{}}
          identity={{ name: 'name', phone: 'phone' }}
          submissionShape="account_and_profile"
          publicHintI18nKey={null}
          consentContent={null}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const submitButton = () =>
  screen.getByRole('button', { name: messages.profile.public_reg.btn_submit });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<PublicRegistrationView /> field errors (#903)', () => {
  it('keeps Submit enabled and, on click, shows which field is wrong and why', async () => {
    renderView();
    fill(/Name/, 'Asha');
    fill(/Mobile/, '9876543210');
    fill(/Website/, 'NA');

    expect(submitButton()).toBeEnabled();
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(document.getElementById('root_website__error')).toHaveTextContent(
        'Invalid entry. Please enter a valid Website.',
      ),
    );
    expect(screen.getByLabelText(/Website/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toContain('must match pattern');
  });

  it('says a missing required field is required, under the field, after Submit', async () => {
    renderView();
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(document.getElementById('root_name__error')).toHaveTextContent('Name is required.'),
    );
  });

  it('shows one readable banner for a non-field failure and keeps the input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/lookup')
          ? new Response('{}', { status: 200 })
          : new Response(JSON.stringify({ error: { code: 'INTERNAL', detail: 'stack trace' } }), {
              status: 500,
              headers: { 'content-type': 'application/json' },
            }),
      ),
    );
    renderView();
    fill(/Name/, 'Asha');
    fill(/Mobile/, '9876543210');
    fireEvent.click(submitButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side.');
    expect(alert).not.toHaveTextContent(/stack trace|INTERNAL|500/);
    expect(screen.getByLabelText(/Name/)).toHaveValue('Asha');
  });

  it('marks the field the server rejected', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'SCHEMA_VALIDATION',
              title: 'Invalid input',
              detail: 'Website: Please enter a valid web address.',
              fields: { field_errors: { website: 'Please enter a valid web address.' } },
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderView();
    fill(/Name/, 'Asha');
    fill(/Mobile/, '9876543210');
    fill(/Website/, 'www.example.org');

    fireEvent.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(document.getElementById('root_website__error')).toHaveTextContent(
        'Invalid entry. Please enter a valid web address.',
      ),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('<PublicRegistrationView /> INVALID_PHONE', () => {
  it('adds the phone message to the other field errors and clears only the edited one', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'INVALID_PHONE',
              fields: { field_errors: { website: 'Please enter a valid web address.' } },
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderView();
    fill(/Name/, 'Asha');
    fill(/Mobile/, '9876543210');
    fill(/Website/, 'www.example.org');
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(document.getElementById('root_phone__error')).toHaveTextContent(
        'Please enter a valid phone number.',
      ),
    );
    expect(document.getElementById('root_website__error')).toHaveTextContent(
      'Please enter a valid web address.',
    );

    fill(/Website/, 'https://example.org');
    await waitFor(() => expect(document.getElementById('root_website__error')).toBeNull());
    expect(document.getElementById('root_phone__error')).toHaveTextContent(
      'Please enter a valid phone number.',
    );
    expect(screen.getByLabelText(/Mobile/)).toHaveValue('9876543210');
  });
});

describe('readableFormErrors', () => {
  it('labels a required error with the field title, without doubling the key', () => {
    const [e] = readableFormErrors(
      [
        {
          name: 'required',
          property: '.phone',
          params: { missingProperty: 'phone' },
          message: "must have required property 'phone'",
          stack: "must have required property 'phone'",
          schemaPath: '#/required',
        },
      ],
      SCHEMA,
    );
    expect(e).toMatchObject({ message: 'is required', stack: 'Mobile: is required.' });
  });

  it('keeps ajv wording for keywords without a rewrite', () => {
    const [e] = readableFormErrors(
      [{ name: 'type', property: '.name', params: {}, message: 'must be string', stack: 'x' }],
      SCHEMA,
    );
    expect(e).toMatchObject({ message: 'must be string', stack: 'Name: must be string.' });
  });
});
