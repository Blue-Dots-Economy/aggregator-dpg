'use client';

import type { JSX } from 'react';
import { useTranslations } from 'next-intl';
import type { RJSFSchema } from '@rjsf/utils';
import { RegisterPageShell } from '../RegisterPageShell';
import { CoordinatorRegisterForm } from '../CoordinatorRegisterForm';
import { InviteUnavailable } from '../InviteUnavailable';
import type { ConsentDocContent } from '../../../../components/consent/consent-types';
import type { InviteReadResult } from '../../../../lib/invite-read.server';

export interface CoordinatorInviteViewProps {
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
  /** Raw invite token from the link. */
  inviteToken: string;
  /** The invite as the server read it, or why it cannot be used. */
  invite: InviteReadResult;
  /** Versioned Terms/Privacy content for the coordinator (aggregator) form. */
  aggregatorConsentContent?: ConsentDocContent | null;
}

/**
 * Coordinator invite landing view.
 *
 * Renders the coordinator form with the org fixed and the invited email
 * locked, or a message when the invite cannot be used.
 *
 * @param props - Coordinator schema/UI schema, the invite and consent content.
 * @returns The coordinator invite page body.
 */
export function CoordinatorInviteView({
  schema,
  uiSchema,
  inviteToken,
  invite,
  aggregatorConsentContent,
}: Readonly<CoordinatorInviteViewProps>): JSX.Element {
  const t = useTranslations('register');
  if (!invite.ok) return <InviteUnavailable reason={invite.reason} />;
  return (
    <RegisterPageShell heading={t('page_title')} tagline={null}>
      <CoordinatorRegisterForm
        schema={schema}
        uiSchema={uiSchema}
        inviteToken={inviteToken}
        lockedOrgName={invite.invite.org.name}
        lockedEmail={invite.invite.email}
        {...(aggregatorConsentContent ? { consentContent: aggregatorConsentContent } : {})}
      />
    </RegisterPageShell>
  );
}
