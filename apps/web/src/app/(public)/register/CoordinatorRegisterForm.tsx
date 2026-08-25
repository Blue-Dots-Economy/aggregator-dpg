'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import { ConsentGate } from '../../../components/consent/ConsentGate';
import { toConsentDocs } from '../../../components/consent/consent-docs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import { jsonFetch } from '../../../services/http';
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

export interface CoordinatorRegisterFormProps {
  /** Coordinator registration JSON Schema. */
  schema: RJSFSchema;
  /** Coordinator registration UI schema. */
  uiSchema: Record<string, unknown>;
  /** True when the org hierarchy is on — shows the required org selector. */
  orgHierarchyEnabled: boolean;
  /**
   * Versioned Terms/Privacy content for the aggregator (coordinator) audience.
   * Flattened via {@link toConsentDocs} into the ordered document list the
   * blocking {@link ConsentGate} reads at submit time. Omit (or pass
   * `undefined`) when `loadConsentConfig` failed — the gate then has nothing
   * to show, so submit surfaces an error instead of opening it.
   */
  consentContent?: ConsentDocContent;
}

/** One active-org option for the coordinator dropdown (`GET /api/orgs`). */
interface OrgOption {
  id: string;
  slug: string;
  display_name: string;
}

/**
 * Renders the coordinator registration form. With the org hierarchy off, it is
 * today's flat form. With it on, it adds a required organisation selector
 * (spec §6.2) populated from the active-org list, hides the free-text
 * organisation name (inherited from the selected org), and gates submit on an
 * org being picked. Bootstrap empty-state shows when no orgs are live yet.
 *
 * @param props - Schema/UI schema + the org-hierarchy flag.
 * @returns The coordinator registration content block.
 */
export function CoordinatorRegisterForm({
  schema,
  uiSchema,
  orgHierarchyEnabled,
  consentContent,
}: CoordinatorRegisterFormProps): JSX.Element {
  const t = useTranslations('register');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const brand = cfg.brand.short_name;

  const { state, setState, canSubmit, setCanSubmit, errorRef } = useRegistrationFormState();
  const [formData, setFormData] = useState<Record<string, unknown>>(() => ({
    locations: [{ geo: { type: 'Point', coordinates: [0, 0] }, address: { addressCountry: 'IN' } }],
  }));
  // Selected parent org (spec §6.2). Empty until picked.
  const [orgId, setOrgId] = useState<string>('');
  const [gateOpen, setGateOpen] = useState(false);
  const pendingRef = useRef<Record<string, unknown> | null>(null);
  const consentDocs = useMemo(() => toConsentDocs(consentContent), [consentContent]);

  // Fetch the active-org list only when the hierarchy is on.
  const orgsQuery = useQuery({
    queryKey: ['active-orgs'],
    queryFn: () => jsonFetch<{ orgs: OrgOption[] }>('/api/orgs'),
    enabled: orgHierarchyEnabled,
    staleTime: 30_000,
  });
  const orgs = orgsQuery.data?.orgs ?? [];
  const noOrgsYet =
    orgHierarchyEnabled && orgsQuery.isSuccess && !orgsQuery.isError && orgs.length === 0;
  // The record inherits the selected org's display name (the name field hides).
  const selectedOrgName = orgs.find((o) => o.id === orgId)?.display_name ?? '';

  // Keep the hidden required `name` in sync with the chosen org so the validity
  // gate passes without the coordinator typing an organisation name.
  useEffect(() => {
    if (!orgHierarchyEnabled) return;
    const next = selectedOrgName || undefined;
    setFormData((prev) => (prev['name'] === next ? prev : { ...prev, name: next }));
  }, [orgHierarchyEnabled, selectedOrgName]);

  const formSchema = useMemo(() => stripConsentBlock(stripFormChrome(schema)), [schema]);

  const agreeLabel = `${t('consent.accept_prefix')}${t('consent.privacy_link')}${t('consent.and')}${t('consent.terms_link')}.`;

  // Flag-on: hide the free-text "Organisation Name" (`name`) — auto-filled from
  // the selected org. Flag-off keeps the flat form unchanged.
  const formUiSchema = useMemo<Record<string, unknown>>(() => {
    if (!orgHierarchyEnabled) return uiSchema;
    return {
      ...uiSchema,
      name: { ...((uiSchema['name'] as Record<string, unknown>) ?? {}), 'ui:widget': 'hidden' },
    };
  }, [uiSchema, orgHierarchyEnabled]);

  /**
   * Holds the payload and opens the gate — consent is collected there.
   * When the consent copy failed to load (`consentDocs` is empty), the gate
   * would render nothing at all and the form would be stuck with no way to
   * finish or explain why — surface an error instead of a dead button.
   */
  const handleSubmit = async (
    e: IChangeEvent<Record<string, unknown>>,
    _event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
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
    // The API strips `org_id` before RJSF validation and stores it on
    // `aggregators.parent_org_id`. Sent only when the hierarchy is on; `name`
    // is the selected org's name (the field is hidden).
    if (orgHierarchyEnabled && orgId) {
      payload['org_id'] = orgId;
      payload['name'] = selectedOrgName;
    }
    const result = await submitRegistration('/api/aggregator/register', payload);
    setState(
      result.ok
        ? { status: 'done', refId: String(result.body['aggregator_id'] ?? '') }
        : { status: 'error', ...result.error },
    );
  };

  if (state.status === 'done') {
    return (
      <RegistrationSuccessPanel
        heading={t('success_heading')}
        refLabel={t('success_ref_id')}
        refId={state.refId}
        message={t('success_approval', { brand })}
      />
    );
  }

  return (
    <div className="mt-7">
      {state.status === 'error' ? (
        <RegistrationErrorBanner
          title={state.title}
          detail={state.detail}
          errorRef={errorRef}
          {...(state.code === 'CLIENT_VALIDATION' ? { rawErrors: state.requestId } : {})}
        />
      ) : null}

      {noOrgsYet ? (
        <div
          role="status"
          className="rounded-[12px] border border-amber-200 bg-amber-50 px-4 py-5 text-[13.5px] text-amber-800"
        >
          {t('coordinator_no_orgs')}
        </div>
      ) : (
        <>
          {orgHierarchyEnabled ? (
            <div className="form-group mb-4">
              <label className="bd-label" htmlFor="coordinator-org">
                {t('org_selector_label')}
                <span className="text-rose-500"> *</span>
              </label>
              {orgsQuery.isError ? (
                <div className="text-[13px] text-red-600 flex items-center gap-2">
                  {t('org_selector_error')}
                  <button
                    type="button"
                    onClick={() => orgsQuery.refetch()}
                    className="text-primary-600 font-semibold hover:underline"
                  >
                    {t('org_selector_retry')}
                  </button>
                </div>
              ) : (
                <Select
                  {...(orgId ? { value: orgId } : {})}
                  onValueChange={setOrgId}
                  disabled={orgsQuery.isLoading}
                >
                  <SelectTrigger id="coordinator-org" aria-required>
                    <SelectValue
                      placeholder={
                        orgsQuery.isLoading
                          ? t('org_selector_loading')
                          : t('org_selector_placeholder')
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {orgs.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ) : null}

          <RjsfThemedForm
            schema={formSchema}
            uiSchema={formUiSchema as unknown as UiSchema<Record<string, unknown>>}
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
              canSubmit={canSubmit && !(orgHierarchyEnabled && !orgId)}
              label={t('submit')}
              submittingLabel={t('submitting')}
            />
          </RjsfThemedForm>
        </>
      )}

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
