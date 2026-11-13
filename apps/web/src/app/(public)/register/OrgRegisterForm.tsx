'use client';

import { useMemo, useState, type JSX } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import type { ResolvedPlace } from '../../../components/forms/custom-widgets/LocationAutocompleteWidget';
import { ConsentGate } from '../../../components/consent/ConsentGate';
import { toConsentDocs } from '../../../components/consent/consent-docs';
import {
  inviteSignInUrl,
  stampConsent,
  stripConsentBlock,
  stripFormChrome,
  submitRegistration,
  withOrgCoordinates,
  withReadonlyField,
  type SubmitError,
} from './registration-shared';
import {
  RegistrationErrorBanner,
  showsErrorBanner,
  RegistrationSubmitButton,
  sharedRegistrationFormProps,
  useConsentGateSubmit,
  useRegistrationError,
  useRegistrationFormState,
} from './registration-ui';
import type { ConsentDocContent } from '../../../components/consent/consent-types';
import { gstinCustomValidate } from '../../../lib/org-schema';
import { withPhoneWidget } from '../../../lib/phone-ui-schema';
import { useFieldErrors } from '@/components/forms/useFieldErrors';

/** Message keys for the API's refusals when the inviting org can no longer take the org. */
const TREE_ERRORS: Record<string, string> = {
  ORG_DEPTH_LIMIT: 'org_error_depth_limit',
  ORG_CHILD_LIMIT: 'org_error_child_limit',
  ORG_TOTAL_LIMIT: 'org_error_total_limit',
  CONFLICT: 'org_error_conflict',
};

/**
 * Returns the message key for a tree refusal, or null for any other error.
 *
 * @param error - The failed submission.
 * @returns A key under `register`, or null.
 */
function treeErrorKey(error: SubmitError): string | null {
  return TREE_ERRORS[error.code] ?? null;
}

/** The invite an invited owner registers with. */
export interface OrgFormInvite {
  token: string;
  /** The invited owner email. */
  email: string;
  /** The inviting org, which the new org registers under. */
  parentName: string;
}

export interface OrgRegisterFormProps {
  /** Org-registration JSON Schema loaded by the server component. */
  schema: RJSFSchema;
  /** RJSF UI schema for the org form. */
  uiSchema: Record<string, unknown>;
  /** Terms/Privacy content for the org audience; omit when loading failed. */
  consentContent?: ConsentDocContent;
  invite: OrgFormInvite;
}

/**
 * Renders the organisation registration form for an invite.
 *
 * The org registers under the inviting org and the owner email is locked to
 * the invited address. After the consent gate it posts to
 * `/api/invite/org/accept` and then goes to sign-in with that email pre-filled.
 *
 * @param props - The org JSON Schema + UI schema, consent content and the invite.
 * @returns The org registration content block.
 */
export function OrgRegisterForm({
  schema,
  uiSchema,
  consentContent,
  invite,
}: OrgRegisterFormProps): JSX.Element {
  const t = useTranslations('register');
  const { state, setState, errorRef } = useRegistrationFormState();
  const [formData, setFormData] = useState<Record<string, unknown>>(() => ({
    owner: { email: invite.email },
  }));
  const [resolvedPlace, setResolvedPlace] = useState<ResolvedPlace | null>(null);
  const consentDocs = useMemo(() => toConsentDocs(consentContent), [consentContent]);
  const { gateOpen, setGateOpen, pendingRef, handleSubmit } = useConsentGateSubmit(
    consentDocs,
    setState,
  );

  const formSchema = useMemo(() => stripConsentBlock(stripFormChrome(schema)), [schema]);
  const formUiSchema = useMemo(
    () =>
      withReadonlyField(withPhoneWidget(uiSchema, formSchema as Record<string, unknown>), [
        'owner',
        'email',
      ]),
    [uiSchema, formSchema],
  );
  const customValidate = useMemo(() => gstinCustomValidate(formSchema), [formSchema]);
  const fieldErrors = useFieldErrors(formSchema);
  const registrationError = useRegistrationError(fieldErrors, {
    email: 'owner.email',
    phone: 'owner.phone',
    name: 'display_name',
  });

  const agreeLabel = `${t('consent.accept_prefix')}${t('consent.privacy_link')}${t('consent.and')}${t('consent.terms_link')}.`;

  /** Runs after the gate is accepted: stamps consent, posts, then goes to sign-in. */
  const submitWithConsent = async (): Promise<void> => {
    setGateOpen(false);
    setState({ status: 'submitting' });
    const body: Record<string, unknown> = {
      ...pendingRef.current,
      consent: stampConsent({ value: true }),
      invite: invite.token,
    };
    const result = await submitRegistration(
      '/api/invite/org/accept',
      withOrgCoordinates(body, resolvedPlace),
    );
    if (!result.ok) {
      const key = treeErrorKey(result.error);
      setState(
        key
          ? {
              status: 'error',
              title: t(key),
              detail: '',
              code: result.error.code,
              requestId: result.error.requestId,
            }
          : registrationError(result.error),
      );
      return;
    }
    setState({ status: 'signing_in' });
    window.location.assign(inviteSignInUrl(result.body, '/console'));
  };

  return (
    <div className="mt-7">
      {showsErrorBanner(state) ? (
        <RegistrationErrorBanner title={state.title} detail={state.detail} errorRef={errorRef} />
      ) : null}

      <output className="mb-5 block text-[13.5px] text-ink-500">
        {t('invite_org_under', { parent: invite.parentName })}
      </output>

      <RjsfThemedForm
        schema={formSchema}
        uiSchema={formUiSchema as unknown as UiSchema<Record<string, unknown>>}
        {...sharedRegistrationFormProps({
          formData,
          setFormData,
          handleSubmit,
          fieldErrors,
          consentContent,
          onLocationResolved: setResolvedPlace,
          personName: {
            path: 'owner.name',
            message: (symbols) => t('name_symbols', { symbols }),
          },
          customValidate,
        })}
      >
        <RegistrationSubmitButton
          submitting={state.status === 'submitting' || state.status === 'signing_in'}
          onAttempt={fieldErrors.markAttempted}
          label={t('org_submit')}
          submittingLabel={t('submitting')}
        />
      </RjsfThemedForm>

      <ConsentGate
        open={gateOpen}
        docs={consentDocs}
        agreeLabel={agreeLabel}
        onAccept={submitWithConsent}
        onCancel={() => setGateOpen(false)}
      />
    </div>
  );
}
