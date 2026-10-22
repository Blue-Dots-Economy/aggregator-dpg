'use client';

import { useMemo, useState, type JSX } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import type { ResolvedPlace } from '../../../components/forms/custom-widgets/LocationAutocompleteWidget';
import { ConsentGate } from '../../../components/consent/ConsentGate';
import { toConsentDocs } from '../../../components/consent/consent-docs';
import {
  stampConsent,
  stripConsentBlock,
  stripFormChrome,
  submitRegistration,
  withOrgCoordinates,
} from './registration-shared';
import {
  RegistrationErrorBanner,
  RegistrationSubmitButton,
  RegistrationSuccessPanel,
  sharedRegistrationFormProps,
  useConsentGateSubmit,
  useRegistrationFormState,
} from './registration-ui';
import type { ConsentDocContent } from '../../../components/consent/consent-types';

export interface OrgRegisterFormProps {
  /** Org-registration JSON Schema loaded by the server component. */
  schema: RJSFSchema;
  /** RJSF UI schema for the org form. */
  uiSchema: Record<string, unknown>;
  /**
   * Terms/Privacy content for the org audience, shown by {@link ConsentGate}
   * at submit. Omit when loading failed; submit then shows an error.
   */
  consentContent?: ConsentDocContent;
}

/**
 * Renders the organisation registration form.
 *
 * Submits through the BFF to `/v1/orgs/create`. A new org stays `pending`
 * until a network admin approves it.
 *
 * @param props - The org JSON Schema + UI schema.
 * @returns The org registration content block (form, success, or error state).
 */
export function OrgRegisterForm({
  schema,
  uiSchema,
  consentContent,
}: OrgRegisterFormProps): JSX.Element {
  const t = useTranslations('register');
  const { state, setState, canSubmit, setCanSubmit, errorRef } = useRegistrationFormState();
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  // Coordinate from the address widget; RJSF does not write it into `formData`.
  const [resolvedPlace, setResolvedPlace] = useState<ResolvedPlace | null>(null);
  const consentDocs = useMemo(() => toConsentDocs(consentContent), [consentContent]);
  const { gateOpen, setGateOpen, pendingRef, handleSubmit } = useConsentGateSubmit(
    consentDocs,
    setState,
  );

  const formSchema = useMemo(() => stripConsentBlock(stripFormChrome(schema)), [schema]);

  const agreeLabel = `${t('consent.accept_prefix')}${t('consent.privacy_link')}${t('consent.and')}${t('consent.terms_link')}.`;

  /** Runs after the gate is accepted: stamps consent and posts. */
  const submitWithConsent = async (): Promise<void> => {
    setGateOpen(false);
    setState({ status: 'submitting' });
    const body: Record<string, unknown> = {
      ...pendingRef.current,
      consent: stampConsent({ value: true }),
    };
    const payload = withOrgCoordinates(body, resolvedPlace);
    const result = await submitRegistration('/api/org/register', payload);
    if (!result.ok) {
      setState({ status: 'error', ...result.error });
      return;
    }
    // 201: new pending registration. 200 with status 'active': the org already
    // exists and its owner was mailed the invite link.
    const alreadyRegistered = result.body['status'] === 'active';
    setState({
      status: 'done',
      refId: String(result.body['slug'] ?? ''),
      outcome: alreadyRegistered ? 'already_registered' : 'pending',
      mailSent: result.body['mail_sent'] !== false,
    });
  };

  if (state.status === 'done') {
    const already = state.outcome === 'already_registered';
    const message = already
      ? state.mailSent === false
        ? t('org_exists_mail_failed')
        : t('org_exists_link_sent')
      : t('org_success_review');
    return (
      <RegistrationSuccessPanel
        heading={already ? t('org_exists_heading') : t('org_success_heading')}
        refLabel={t('org_success_slug')}
        refId={state.refId}
        message={message}
      />
    );
  }

  return (
    <div className="mt-7">
      {state.status === 'error' ? (
        <RegistrationErrorBanner title={state.title} detail={state.detail} errorRef={errorRef} />
      ) : null}

      <RjsfThemedForm
        schema={formSchema}
        uiSchema={uiSchema as unknown as UiSchema<Record<string, unknown>>}
        {...sharedRegistrationFormProps({
          formData,
          setFormData,
          setCanSubmit,
          setState,
          handleSubmit,
          formSchema,
          consentContent,
          onLocationResolved: setResolvedPlace,
          validationErrorTitle: t('validation_error_title'),
        })}
      >
        <RegistrationSubmitButton
          submitting={state.status === 'submitting'}
          canSubmit={canSubmit}
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
