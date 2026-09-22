'use client';

import { useMemo, useState, type JSX } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import type { ResolvedPlace } from '../../../components/forms/custom-widgets/LocationAutocompleteWidget';
import { ConsentGate } from '../../../components/consent/ConsentGate';
import { toConsentDocs } from '../../../components/consent/consent-docs';
import {
  humaniseValidationErrors,
  stampConsent,
  stripConsentBlock,
  stripFormChrome,
  submitRegistration,
} from './registration-shared';
import {
  RegistrationErrorBanner,
  RegistrationSubmitButton,
  RegistrationSuccessPanel,
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
   * Versioned Terms/Privacy content for the org audience. Flattened via
   * {@link toConsentDocs} into the ordered document list the blocking
   * {@link ConsentGate} reads at submit time. Omit (or pass `undefined`)
   * when `loadConsentConfig` failed — the gate then has nothing to show, so
   * submit surfaces an error instead of opening it.
   */
  consentContent?: ConsentDocContent;
}

/**
 * Renders the parent-org registration form (spec §6.1). Submits to the BFF
 * proxy which forwards to `/v1/orgs/create`; on success the org sits `pending`
 * until a network admin approves it. Shown only when the org hierarchy flag is
 * on — the caller gates rendering.
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
  // Coordinate the address widget resolved, held outside `formData` because
  // RJSF hands `formContext` to widgets one-way and never writes it back.
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
    const payload: Record<string, unknown> = {
      // No `?? {}`: spreading null contributes nothing, so the fallback
      // object was dead weight rather than a guard.
      ...pendingRef.current,
      consent: stampConsent({ value: true }),
      // Flat here, unlike the coordinator's nested `locations[0].geo`: the org
      // body has no location array, so the coordinate rides alongside the
      // address and lands in `aggregator_orgs.profile`. GeoJSON order,
      // [longitude, latitude], to match the coordinator side.
      ...(resolvedPlace ? { coordinates: [resolvedPlace.lng, resolvedPlace.lat] } : {}),
    };
    const result = await submitRegistration('/api/org/register', payload);
    if (!result.ok) {
      setState({ status: 'error', ...result.error });
      return;
    }
    // A 201 is a new pending registration; a 200 with status 'active' means the
    // org already existed and its owner was mailed the invite link instead.
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
        formData={formData}
        // RJSF v6 exposes this to widgets only as `registry.formContext`,
        // never as a prop — see the note in LocationAutocompleteWidget.
        formContext={{ consentContent, onLocationResolved: setResolvedPlace }}
        onChange={(e) => setFormData(e.formData as Record<string, unknown>)}
        onValidityChange={setCanSubmit}
        onSubmit={handleSubmit}
        onError={(errs) => {
          setState({
            status: 'error',
            title: t('validation_error_title'),
            detail: humaniseValidationErrors(errs, formSchema).join('\n'),
            code: 'CLIENT_VALIDATION',
            requestId: JSON.stringify(errs, null, 2),
          });
        }}
        showErrorList={false}
        focusOnFirstError
        noHtml5Validate
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
