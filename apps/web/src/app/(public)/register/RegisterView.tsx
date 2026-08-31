'use client';

import { type JSX } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { RegisterPageShell } from './RegisterPageShell';
import { CoordinatorRegisterForm } from './CoordinatorRegisterForm';
import type { ConsentDocContent } from '../../../components/consent/consent-types';

export interface RegisterViewProps {
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
  /**
   * True when `ORG_HIERARCHY_ENABLED` is on — the coordinator form then shows
   * the required parent-org selector. Owner/organisation registration is no
   * longer a tab here; it lives on the `/register/owner` deep link (#619).
   */
  orgHierarchyEnabled?: boolean;
  /**
   * Versioned Terms/Privacy content for the coordinator (aggregator) form.
   * Forwarded to {@link CoordinatorRegisterForm} as `consentContent`, which
   * flattens it via `toConsentDocs` for the blocking `ConsentGate`.
   * `null` when `loadConsentConfig` failed — the form then surfaces an error
   * on submit instead of opening an empty gate.
   */
  aggregatorConsentContent?: ConsentDocContent | null;
}

/**
 * Public coordinator registration page: the shared registration shell wrapping
 * the single coordinator form.
 *
 * Owner (organisation) registration used to be a second tab here; as of #619 it
 * is removed from the public page and served only via the `/register/owner`
 * deep link. The `orgHierarchyEnabled` flag now only toggles the coordinator
 * form's parent-org selector — there are no tabs.
 *
 * @param props - Coordinator schema/UI schema, the org-hierarchy flag (for the
 *   org selector), and the aggregator consent content.
 * @returns The registration page body.
 */
export function RegisterView({
  schema,
  uiSchema,
  orgHierarchyEnabled = false,
  aggregatorConsentContent,
}: RegisterViewProps): JSX.Element {
  const headingTitle = (schema.title as string | undefined) ?? 'Aggregator Registration';

  return (
    <RegisterPageShell heading={headingTitle}>
      <CoordinatorRegisterForm
        schema={schema}
        uiSchema={uiSchema}
        orgHierarchyEnabled={orgHierarchyEnabled}
        {...(aggregatorConsentContent ? { consentContent: aggregatorConsentContent } : {})}
      />
    </RegisterPageShell>
  );
}
