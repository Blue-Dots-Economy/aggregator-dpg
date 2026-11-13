/**
 * View test: <MinimalIdentityForm /> — identity-only capture for
 * `submission_shape === 'account_only'` public links.
 *
 * Covers: field visibility driven by the `identity` selector map, the
 * per-field messages for name, contact, year of birth and consent (including
 * the voice-mode required-phone variant), the U18 no-consent branch, and the submit payload
 * shape. The form's own terms/privacy line + `ConsentModal` were removed in
 * #636 Task 8 — that consent now runs through the parent
 * (`PublicRegistrationView`)'s blocking gate; see
 * `PublicRegistrationView.account-only-consent-gate.test.tsx` and
 * `.account-only-consent-submit.test.tsx`. `consentCall` (the call-permission
 * checkbox covered below) is a distinct consent this form still owns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';

import { MinimalIdentityForm } from '@/app/[org]/[slug]/MinimalIdentityForm';
import { chooseOption } from '@/__tests__/test-utils';

const currentYear = new Date().getFullYear();
const validYear = String(currentYear - 25);
const minorYear = String(currentYear - 10);
const submitLabel = messages.profile.public_reg.account_only.submit_label;
const errors = messages.profile.public_reg.account_only.errors;
function renderForm(props: Partial<React.ComponentProps<typeof MinimalIdentityForm>> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn();
  const utils = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MinimalIdentityForm
        identity={{ name: 'name', phone: 'phone', email: 'email' }}
        onSubmit={onSubmit}
        showConsent
        showBirthYear
        {...props}
      />
    </NextIntlClientProvider>,
  );
  return { ...utils, onSubmit };
}

async function fillCommon(getByLabel: (l: string | RegExp) => HTMLElement) {
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } });
  await chooseOption(screen.getByLabelText(/Year of birth/), String(validYear));
  void getByLabel;
}

describe('<MinimalIdentityForm />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders phone and email fields when both identity selectors are present', () => {
    renderForm();
    expect(screen.getByLabelText(/Phone/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Email/)).toBeInTheDocument();
  });

  it('hides the phone field when identity.phone is not declared', () => {
    renderForm({ identity: { name: 'name', email: 'email' } });
    expect(screen.queryByLabelText(/^Phone/)).toBeNull();
  });

  it('hides the email field when identity.email is not declared', () => {
    renderForm({ identity: { name: 'name', phone: 'phone' } });
    expect(screen.queryByLabelText(/^Email/)).toBeNull();
  });

  it('keeps Submit enabled and shows each missing field under it on an empty submit', () => {
    const { onSubmit } = renderForm();
    const submit = screen.getByRole('button', { name: submitLabel });
    expect(submit).toBeEnabled();
    expect(screen.queryByText('Name is required.')).toBeNull();
    fireEvent.click(submit);
    expect(screen.getByText('Name is required.')).toBeInTheDocument();
    expect(screen.getByText('Year of birth is required.')).toBeInTheDocument();
    expect(screen.getByText(errors.contact_required)).toBeInTheDocument();
    expect(screen.getByText('Call consent is required.')).toBeInTheDocument();
    const name = screen.getByLabelText(/Name/);
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAttribute('aria-describedby', 'account-only-name__error');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows an invalid phone number under the field once it is left', async () => {
    renderForm();
    await fillCommon(screen.getByLabelText.bind(screen));
    const phone = screen.getByLabelText(/Phone/);
    fireEvent.change(phone, { target: { value: '123' } });
    expect(screen.queryByText(/Enter a valid mobile number/)).toBeNull();
    fireEvent.blur(phone);
    expect(screen.getByText(`Invalid entry. ${errors.phone_invalid}`)).toBeInTheDocument();
  });

  it('shows an invalid email under the field once it is left', async () => {
    renderForm();
    await fillCommon(screen.getByLabelText.bind(screen));
    const email = screen.getByLabelText(/Email/);
    fireEvent.change(email, { target: { value: 'not-an-email' } });
    fireEvent.blur(email);
    expect(screen.getByText(`Invalid entry. ${errors.email_invalid}`)).toBeInTheDocument();
  });

  it('shows server messages under their fields and drops one when that field is edited', () => {
    renderForm({ serverErrors: { phone: 'Server says no.' } });
    expect(screen.getByText('Server says no.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    expect(screen.queryByText('Server says no.')).toBeNull();
  });

  it('enables submit once name + valid phone + year of birth + consent are set', async () => {
    renderForm();
    await fillCommon(screen.getByLabelText.bind(screen));
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(
      screen.getByRole('button', { name: messages.profile.public_reg.account_only.submit_label }),
    ).toBeEnabled();
  });

  it('submits the identity payload with the network field keys on click', async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    await fillCommon(screen.getByLabelText.bind(screen));
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(
      screen.getByRole('button', { name: messages.profile.public_reg.account_only.submit_label }),
    );
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Jane Doe',
        phone: '+919876543210',
        year_of_birth: validYear,
      }),
    );
    // #636 Task 8: consent_terms/consent_privacy are no longer set by this
    // form — the parent view stamps them from its own blocking consent gate.
    // Leaving the call-permission checkbox's value here would have been the
    // silent-mis-record bug the task fixed (the parent used to overwrite
    // whatever this form sent with `false` anyway).
    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload['consent_terms']).toBeUndefined();
    expect(payload['consent_privacy']).toBeUndefined();
  });

  it('keeps the typed input after the server rejects the submit', async () => {
    const onSubmit = vi.fn();
    const tree = (props: Partial<React.ComponentProps<typeof MinimalIdentityForm>>) => (
      <NextIntlClientProvider locale="en" messages={messages}>
        <MinimalIdentityForm
          identity={{ name: 'name', phone: 'phone', email: 'email' }}
          onSubmit={onSubmit}
          showConsent
          showBirthYear
          {...props}
        />
      </NextIntlClientProvider>
    );
    const { rerender } = render(tree({}));
    await fillCommon(screen.getByLabelText.bind(screen));
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'jane@example.org' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: submitLabel }));
    expect(onSubmit).toHaveBeenCalled();

    rerender(tree({ busy: true }));
    rerender(tree({ busy: false, serverErrors: { email: 'Email already used.' } }));

    expect(screen.getByText('Email already used.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/)).toHaveValue('Jane Doe');
    expect(screen.getByLabelText(/Phone/)).toHaveValue('9876543210');
    expect(screen.getByLabelText(/Email/)).toHaveValue('jane@example.org');
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('requires phone and hides nothing else in voice mode (requirePhone)', () => {
    renderForm({ requirePhone: true });
    fireEvent.click(screen.getByRole('button', { name: submitLabel }));
    expect(screen.getByText('Phone is required.')).toBeInTheDocument();
    expect(screen.queryByText(errors.contact_required)).toBeNull();
  });

  it('shows the U18 notice and skips consent for a minor, still allowing submit', async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Kid' } });
    await chooseOption(screen.getByLabelText(/Year of birth/), String(minorYear));
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    expect(
      screen.getByText(messages.profile.public_reg.account_only.u18_notice),
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: messages.profile.public_reg.account_only.submit_label }),
    );
    expect(onSubmit).toHaveBeenCalled();
  });

  it('keeps the call-permission checkbox on the form (a distinct consent from the parent gate)', () => {
    renderForm();
    expect(
      screen.getByRole('checkbox', { name: /permit the aggregator to trigger the call/i }),
    ).toBeInTheDocument();
  });

  it('renders the submit button disabled while `busy` is true even when otherwise valid', async () => {
    renderForm({ busy: true });
    await fillCommon(screen.getByLabelText.bind(screen));
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(
      screen.getByRole('button', { name: messages.profile.public_reg.account_only.submit_label }),
    ).toBeDisabled();
  });

  it('offers no future year and asks for a year on submit until one is chosen', async () => {
    const { onSubmit } = renderForm();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane' } });
    fireEvent.click(screen.getByRole('button', { name: submitLabel }));
    expect(screen.getByText('Year of birth is required.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Year of birth/));
    expect(await screen.findByRole('option', { name: String(currentYear) })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: String(currentYear + 1) })).toBeNull();
  });
});
