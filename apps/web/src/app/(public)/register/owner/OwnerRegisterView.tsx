'use client';

import { type JSX } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { RegisterPageShell } from '../RegisterPageShell';
import { OrgRegisterForm } from '../OrgRegisterForm';
import type { ConsentDocContent } from '../../../../components/consent/consent-types';

export interface OwnerRegisterViewProps {
  /** Org-registration JSON Schema loaded by the owner server route. */
  schema: RJSFSchema;
  /** RJSF UI schema for the org form. */
  uiSchema: Record<string, unknown>;
  /**
   * Terms/Privacy content for the org audience. `null` when loading failed;
   * the widget then shows plain text.
   */
  orgConsentContent?: ConsentDocContent | null;
}

/**
 * Owner (organisation) registration page body for `/register/owner`.
 *
 * Wraps {@link OrgRegisterForm} in {@link RegisterPageShell}. The route has
 * already checked that the org schema exists.
 *
 * @param props - The org schema/UI schema and org consent content.
 * @returns The owner registration page body.
 */
export function OwnerRegisterView({
  schema,
  uiSchema,
  orgConsentContent,
}: Readonly<OwnerRegisterViewProps>): JSX.Element {
  const t = useTranslations('register');
  const headingTitle = (schema.title as string | undefined) ?? t('owner_page_title');

  return (
    <RegisterPageShell heading={headingTitle}>
      <OrgRegisterForm
        schema={schema}
        uiSchema={uiSchema}
        {...(orgConsentContent ? { consentContent: orgConsentContent } : {})}
      />
    </RegisterPageShell>
  );
}
