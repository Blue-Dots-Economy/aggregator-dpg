'use client';

import { useMemo, useRef, useState, type JSX } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
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
  const [gateOpen, setGateOpen] = useState(false);
  const pendingRef = useRef<Record<string, unknown> | null>(null);
  const consentDocs = useMemo(() => toConsentDocs(consentContent), [consentContent]);

  const formSchema = useMemo(() => stripConsentBlock(stripFormChrome(schema)), [schema]);

  const agreeLabel = `${t('consent.accept_prefix')}${t('consent.privacy_link')}${t('consent.and')}${t('consent.terms_link')}.`;

  /**
   * Holds the payload and opens the gate — consent is collected there.
   * When the consent copy failed to load (`consentDocs` is empty), the gate
   * would render nothing at all and the form would be stuck with no way to
   * finish or explain why — surface an error instead of a dead button.
   */
  const handleSubmit = async (e: IChangeEvent<Record<string, unknown>>): Promise<void> => {
    pendingRef.current = (e.formData ?? {}) as Record<string, unknown>;
    if (consentDocs.length === 0) {
      setState({
        status: 'error',
        title: t('consent.load_failed_title'),
        detail: t('consent.load_failed_detail'),
        code: 'CONSENT_UNAVAILABLE',
        requestId: '',
      });
      return;
    }
    setGateOpen(true);
  };

  /** Runs after the gate is accepted: stamps consent and posts. */
  const submitWithConsent = async (): Promise<void> => {
    setGateOpen(false);
    setState({ status: 'submitting' });
    const payload: Record<string, unknown> = {
      // No `?? {}`: spreading null contributes nothing, so the fallback
      // object was dead weight rather than a guard.
      ...pendingRef.current,
      consent: stampConsent({ value: true }),
    };
    const result = await submitRegistration('/api/org/register', payload);
    setState(
      result.ok
        ? { status: 'done', refId: String(result.body['slug'] ?? '') }
        : { status: 'error', ...result.error },
    );
  };

  if (state.status === 'done') {
    return (
      <RegistrationSuccessPanel
        heading={t('org_success_heading')}
        refLabel={t('org_success_slug')}
        refId={state.refId}
        message={t('org_success_review')}
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
        formContext={{ consentContent }}
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
