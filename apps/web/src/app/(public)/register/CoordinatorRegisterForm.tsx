'use client';

import { useEffect, useMemo, useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import type { ResolvedPlace } from '../../../components/forms/custom-widgets/LocationAutocompleteWidget';
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
  stampConsent,
  stripConsentBlock,
  stripFormChrome,
  submitRegistration,
  withResolvedCoordinates,
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

export interface CoordinatorRegisterFormProps {
  /** Coordinator registration JSON Schema. */
  schema: RJSFSchema;
  /** Coordinator registration UI schema. */
  uiSchema: Record<string, unknown>;
  /**
   * Versioned Terms/Privacy content for the aggregator (coordinator) audience.
   * Flattened via {@link toConsentDocs} into the ordered document list the
   * blocking {@link ConsentGate} reads at submit time. Omit (or pass
   * `undefined`) when `loadConsentConfig` failed — the gate then has nothing
   * to show, so submit surfaces an error instead of opening it.
   */
  consentContent?: ConsentDocContent;
  /**
   * Invite mode (#701). When set, this is an invite-bound registration: the org
   * selector is replaced by the fixed inviting org, the bound email is
   * prefilled + locked, and the submission carries `invite` (not `org_id`) so
   * the API validates + consumes the invite. The server re-validates
   * everything — these props are UX only.
   */
  inviteToken?: string;
  /** The inviting org's display name (invite mode) — fills the hidden `name`. */
  lockedOrgName?: string;
  /** The invite's bound email (invite mode) — prefilled + read-only. */
  lockedEmail?: string;
}

/** One active-org option for the coordinator dropdown (`GET /api/orgs`). */
interface OrgOption {
  id: string;
  slug: string;
  display_name: string;
}

/** Slug of the fixed Default org (migration 0028). */
const DEFAULT_ORG_SLUG = 'default';

/**
 * Removes the schema properties marked `"x-org-detail": true` (url, locations):
 * they belong to the coordinator's org, so a coordinator of a real org neither
 * sees nor submits them (migration 0028).
 *
 * @param schema - The coordinator form schema.
 * @returns The schema without org-detail properties.
 */
function withoutOrgDetails(schema: RJSFSchema): RJSFSchema {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const orgDetailKeys = Object.keys(props).filter((k) => props[k]?.['x-org-detail'] === true);
  if (orgDetailKeys.length === 0) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(props).filter(([k]) => !orgDetailKeys.includes(k)),
    ) as RJSFSchema['properties'],
    ...(Array.isArray(schema.required)
      ? { required: schema.required.filter((k) => !orgDetailKeys.includes(k)) }
      : {}),
  };
}

/**
 * Renders the coordinator registration form with a required organisation
 * selector (spec §6.2; always on since migration 0028) populated from the
 * active-org list. Picking a real org inherits its name and hides the
 * org-detail fields (they are the org's); picking the Default org keeps the
 * flat form — the coordinator names its own organisation and enters its own
 * url / locations. The Default org is preselected when it is the only one.
 *
 * @param props - Schema/UI schema, consent content and the invite context.
 * @returns The coordinator registration content block.
 */
export function CoordinatorRegisterForm({
  schema,
  uiSchema,
  consentContent,
  inviteToken,
  lockedOrgName,
  lockedEmail,
}: CoordinatorRegisterFormProps): JSX.Element {
  const t = useTranslations('register');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const brand = cfg.brand.short_name;
  // Invite mode: org is fixed by the invite, so no selector / no org list.
  const inviteMode = Boolean(inviteToken);

  const { state, setState, canSubmit, setCanSubmit, errorRef } = useRegistrationFormState();
  const [formData, setFormData] = useState<Record<string, unknown>>(() => ({
    // `[0,0]` stands for "not resolved yet": `locations.items.required`
    // includes `geo`, so the entry cannot omit it. The real coordinate is
    // stitched in at submit from whatever the address widget resolved.
    locations: [{ geo: { type: 'Point', coordinates: [0, 0] }, address: {} }],
    // Prefill the invite-bound email so it can't be mistyped (also locked below).
    ...(lockedEmail ? { contact: { email: lockedEmail } } : {}),
  }));
  // Selected parent org (spec §6.2). Empty until picked.
  const [orgId, setOrgId] = useState<string>('');
  // Coordinate the address widget resolved, held outside `formData` because
  // RJSF hands `formContext` to widgets one-way and never writes it back.
  const [resolvedPlace, setResolvedPlace] = useState<ResolvedPlace | null>(null);
  const consentDocs = useMemo(() => toConsentDocs(consentContent), [consentContent]);
  const { gateOpen, setGateOpen, pendingRef, handleSubmit } = useConsentGateSubmit(
    consentDocs,
    setState,
  );

  // The active-org list (not needed in invite mode: the org is fixed).
  const orgsQuery = useQuery({
    queryKey: ['active-orgs'],
    queryFn: () => jsonFetch<{ orgs: OrgOption[] }>('/api/orgs'),
    enabled: !inviteMode,
    staleTime: 30_000,
  });
  const orgs = useMemo(() => orgsQuery.data?.orgs ?? [], [orgsQuery.data]);
  const selectedOrg = orgs.find((o) => o.id === orgId);
  // A real org lends the coordinator its name and its details; the Default org
  // has neither, so its coordinators fill them in themselves (as flat mode did).
  const inheritsFromOrg =
    inviteMode || (selectedOrg !== undefined && selectedOrg.slug !== DEFAULT_ORG_SLUG);
  const selectedOrgName = inviteMode ? (lockedOrgName ?? '') : (selectedOrg?.display_name ?? '');

  // The API lists the Default org only while it is the only active org:
  // preselect it then, so a formerly-flat instance's form works as before.
  useEffect(() => {
    if (inviteMode || orgId) return;
    const only = orgs.length === 1 ? orgs[0] : undefined;
    if (only?.slug === DEFAULT_ORG_SLUG) setOrgId(only.id);
  }, [inviteMode, orgId, orgs]);

  // Keep the hidden required `name` in sync with an inherited org name; drop
  // an inherited name again when the coordinator switches to the Default org.
  useEffect(() => {
    if (inheritsFromOrg) {
      const next = selectedOrgName || undefined;
      setFormData((prev) => (prev['name'] === next ? prev : { ...prev, name: next }));
    } else {
      setFormData((prev) =>
        orgs.some((o) => o.display_name === prev['name']) ? { ...prev, name: undefined } : prev,
      );
    }
  }, [inheritsFromOrg, selectedOrgName, orgs]);

  const formSchema = useMemo(() => {
    const base = stripConsentBlock(stripFormChrome(schema));
    return inheritsFromOrg ? withoutOrgDetails(base) : base;
  }, [schema, inheritsFromOrg]);

  const agreeLabel = `${t('consent.accept_prefix')}${t('consent.privacy_link')}${t('consent.and')}${t('consent.terms_link')}.`;

  // A real org: hide the free-text "Organisation Name" (`name`) — inherited
  // from the selected org. The Default org keeps the flat form.
  const formUiSchema = useMemo<Record<string, unknown>>(() => {
    if (!inheritsFromOrg) return uiSchema;
    // Hide the org-name field (inherited from the org); the invited email is
    // prefilled but stays editable (#701) — a coordinator may register with a
    // different address, and the owner sees the mismatch at approval.
    return {
      ...uiSchema,
      name: { ...((uiSchema['name'] as Record<string, unknown>) ?? {}), 'ui:widget': 'hidden' },
    };
  }, [uiSchema, inheritsFromOrg]);

  /** Runs after the gate is accepted: stamps consent and posts. */
  const submitWithConsent = async (): Promise<void> => {
    setGateOpen(false);
    setState({ status: 'submitting' });
    const payload: Record<string, unknown> = withResolvedCoordinates(
      {
        // No `?? {}`: spreading null contributes nothing, so the fallback
        // object was dead weight rather than a guard.
        ...pendingRef.current,
        consent: stampConsent({ value: true }),
      },
      resolvedPlace,
    );
    // The API strips `org_id`/`invite` before RJSF validation and stores the
    // resolved org on `users.org_id`. In invite mode the org comes from the
    // token claim (never `org_id`); otherwise from the dropdown. A real org's
    // name and details are its own, so none are submitted for it.
    if (inviteMode) {
      payload['invite'] = inviteToken;
    } else if (orgId) {
      payload['org_id'] = orgId;
    }
    if (inheritsFromOrg) {
      payload['name'] = selectedOrgName;
      delete payload['url'];
      delete payload['locations'];
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

      <>
        {inviteMode ? (
          <output className="mb-5 block text-[13.5px] text-ink-500">
            Registering as a coordinator under{' '}
            <span className="font-semibold text-ink-800">{selectedOrgName}</span>.
          </output>
        ) : null}
        {!inviteMode ? (
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
            canSubmit={canSubmit && (inviteMode || Boolean(orgId))}
            label={t('submit')}
            submittingLabel={t('submitting')}
          />
        </RjsfThemedForm>
      </>

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
