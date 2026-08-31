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
   * Versioned Terms/Privacy content for the org audience. `null` when
   * `loadConsentConfig` failed — the widget degrades to plain text.
   */
  orgConsentContent?: ConsentDocContent | null;
}

/**
 * Owner (organisation) registration page reached only via the `/register/owner`
 * deep link (#619) — not linked from the public `/register` page. Wraps
 * {@link OrgRegisterForm} in the shared {@link RegisterPageShell}. The route
 * that renders this view has already asserted the org-hierarchy flag and the
 * presence of the org schema, so this view assumes the owner flow is live.
 *
 * @param props - The org schema/UI schema and org consent content.
 * @returns The owner registration page body.
 */
export function OwnerRegisterView({
  schema,
  uiSchema,
  orgConsentContent,
}: OwnerRegisterViewProps): JSX.Element {
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
