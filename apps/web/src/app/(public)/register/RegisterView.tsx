'use client';

import type { RJSFSchema } from '@rjsf/utils';
import { RegisterShell } from './RegisterShell';
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
   * Passed as `formContext.consentContent` to the RJSF form so the
   * {@link ConsentCheckboxWidget} can render clickable links.
   * `null` when `loadConsentConfig` failed — widget degrades to plain text.
   */
  aggregatorConsentContent?: ConsentDocContent | null;
}

/**
 * Public coordinator registration page: brand shell + the coordinator form.
 *
 * Owner (organisation) registration used to be a second tab here; as of #619
 * it is removed from the public page and served only via the `/register/owner`
 * deep link. This view is now always the single coordinator flow — the
 * `orgHierarchyEnabled` flag only toggles the coordinator's parent-org
 * selector.
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
  const heading = (schema.title as string | undefined) ?? 'Aggregator Registration';

  return (
    <RegisterShell heading={heading}>
      <CoordinatorRegisterForm
        schema={schema}
        uiSchema={uiSchema}
        orgHierarchyEnabled={orgHierarchyEnabled}
        {...(aggregatorConsentContent ? { consentContent: aggregatorConsentContent } : {})}
      />
    </RegisterShell>
  );
}
