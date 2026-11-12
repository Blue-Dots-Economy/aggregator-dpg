'use client';

import { useMemo, useState, type JSX } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { RjsfThemedForm } from '../../../components/forms/RjsfThemed';
import type { ResolvedPlace } from '../../../components/forms/custom-widgets/LocationAutocompleteWidget';
import { ConsentGate } from '../../../components/consent/ConsentGate';
import { toConsentDocs } from '../../../components/consent/consent-docs';
import { withPhoneWidget } from '../../../lib/phone-ui-schema';
import {
  inviteSignInUrl,
  stampConsent,
  stripConsentBlock,
  stripFormChrome,
  submitRegistration,
  withReadonlyField,
  withResolvedCoordinates,
} from './registration-shared';
import {
  RegistrationErrorBanner,
  showsErrorBanner,
  RegistrationSubmitButton,
  sharedRegistrationFormProps,
  useConsentGateSubmit,
  useRegistrationFormState,
} from './registration-ui';
import type { ConsentDocContent } from '../../../components/consent/consent-types';

export interface CoordinatorRegisterFormProps {
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
  /** Terms/Privacy content for the coordinator audience; omit when loading failed. */
  consentContent?: ConsentDocContent;
  /** The invite token from the link; sent with the registration. */
  inviteToken: string;
  /** The inviting org, which the coordinator joins. */
  lockedOrgName: string;
  /** The invited email; the field is locked to it. */
  lockedEmail: string;
}

/**
 * Removes schema properties marked `"x-org-detail": true` (url, locations).
 *
 * These belong to the org, so a coordinator of a real org does not see or submit them.
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
 * Renders the coordinator registration form for an invite.
 *
 * The org is fixed by the invite, so its name, url and locations are not asked
 * for, and the email is locked to the invited address. After the consent gate
 * it posts to `/api/invite/user/accept` and then goes to sign-in with the
 * invited email pre-filled.
 *
 * @param props - Schema/UI schema, consent content and the invite.
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
  const { state, setState, setCanSubmit, errorRef } = useRegistrationFormState();
  const [formData, setFormData] = useState<Record<string, unknown>>(() => ({
    name: lockedOrgName,
    contact: { email: lockedEmail },
  }));
  const [resolvedPlace, setResolvedPlace] = useState<ResolvedPlace | null>(null);
  const consentDocs = useMemo(() => toConsentDocs(consentContent), [consentContent]);
  const { gateOpen, setGateOpen, pendingRef, handleSubmit } = useConsentGateSubmit(
    consentDocs,
    setState,
  );

  const formSchema = useMemo(
    () => withoutOrgDetails(stripConsentBlock(stripFormChrome(schema))),
    [schema],
  );
  const agreeLabel = `${t('consent.accept_prefix')}${t('consent.privacy_link')}${t('consent.and')}${t('consent.terms_link')}.`;
  const formUiSchema = useMemo<Record<string, unknown>>(() => {
    const locked = withReadonlyField(
      withPhoneWidget(uiSchema, formSchema as Record<string, unknown>),
      ['contact', 'email'],
    );
    return {
      ...locked,
      name: { ...(locked['name'] as Record<string, unknown> | undefined), 'ui:widget': 'hidden' },
    };
  }, [uiSchema, formSchema]);

  /** Runs after the gate is accepted: stamps consent, posts, then goes to sign-in. */
  const submitWithConsent = async (): Promise<void> => {
    setGateOpen(false);
    setState({ status: 'submitting' });
    const payload: Record<string, unknown> = withResolvedCoordinates(
      { ...pendingRef.current, consent: stampConsent({ value: true }) },
      resolvedPlace,
    );
    payload['invite'] = inviteToken;
    payload['name'] = lockedOrgName;
    delete payload['url'];
    delete payload['locations'];
    const result = await submitRegistration('/api/invite/user/accept', payload);
    if (!result.ok) {
      setState({ status: 'error', ...result.error });
      return;
    }
    setState({ status: 'signing_in' });
    window.location.assign(inviteSignInUrl(result.body, '/dashboard'));
  };

  return (
    <div className="mt-7">
      {showsErrorBanner(state) ? (
        <RegistrationErrorBanner title={state.title} detail={state.detail} errorRef={errorRef} />
      ) : null}

      <output className="mb-5 block text-[13.5px] text-ink-500">
        {t('invite_coordinator_under', { org: lockedOrgName })}
      </output>

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
          personName: {
            path: 'contact.name',
            message: (symbols) => t('name_symbols', { symbols }),
          },
        })}
      >
        <RegistrationSubmitButton
          submitting={state.status === 'submitting' || state.status === 'signing_in'}
          canSubmit
          label={t('submit')}
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
