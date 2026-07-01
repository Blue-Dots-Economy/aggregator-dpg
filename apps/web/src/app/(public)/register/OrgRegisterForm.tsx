'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import {
  humaniseValidationErrors,
  stampConsent,
  submitRegistration,
  type SubmitState,
} from './registration-shared';
import { RegistrationErrorBanner, RegistrationSuccessPanel } from './registration-ui';

export interface OrgRegisterFormProps {
  /** Org-registration JSON Schema loaded by the server component. */
  schema: RJSFSchema;
  /** RJSF UI schema for the org form. */
  uiSchema: Record<string, unknown>;
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
export function OrgRegisterForm({ schema, uiSchema }: OrgRegisterFormProps): JSX.Element {
  const t = useTranslations('register');
  const [formData, setFormData] = useState<Record<string, unknown>>(() => ({
    consent: stampConsent(undefined),
  }));
  const [state, setState] = useState<SubmitState>({ status: 'idle' });
  const [canSubmit, setCanSubmit] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.status === 'error' && errorRef.current) {
      errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      errorRef.current.focus();
    }
  }, [state]);

  // Drop the schema title/description from the rendered form — the page owns
  // the heading and the description is an API-contract note, not UI copy.
  const formSchema = useMemo<RJSFSchema>(() => {
    const clone: RJSFSchema = { ...schema };
    delete (clone as { title?: string }).title;
    delete (clone as { description?: string }).description;
    return clone;
  }, [schema]);

  const handleSubmit = async (
    e: IChangeEvent<Record<string, unknown>>,
    _event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    setState({ status: 'submitting' });
    const payload = {
      ...(e.formData ?? {}),
      consent: stampConsent(
        (e.formData as Record<string, unknown> | undefined)?.consent as
          | Record<string, unknown>
          | undefined,
      ),
    };
    const result = await submitRegistration('/api/org/register', payload);
    if (result.ok) {
      setState({ status: 'done', refId: String(result.body['slug'] ?? '') });
    } else {
      setState({ status: 'error', ...result.error });
    }
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
        <div className="mt-4 flex flex-col gap-3">
          <button
            type="submit"
            disabled={state.status === 'submitting' || !canSubmit}
            className={`w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white transition-all
              ${
                state.status === 'submitting' || !canSubmit
                  ? 'bg-[var(--bd-primary-100)] text-[var(--bd-primary-600)] cursor-not-allowed'
                  : 'bg-[var(--bd-primary)] hover:bg-[var(--bd-primary-600)] bd-shadow-lg'
              }`}
          >
            {state.status === 'submitting' ? t('submitting') : t('org_submit')}
          </button>
        </div>
      </RjsfThemedForm>
    </div>
  );
}
