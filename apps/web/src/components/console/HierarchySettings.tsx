/** The network's hierarchy settings: the "known as" values it defines for top-level organisations. */

import { useTranslations } from 'next-intl';
import type { OrgHierarchyResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { KnownAsValuesEditor } from './KnownAsValuesEditor';

/**
 * Renders the hierarchy settings.
 *
 * @param hierarchy - The settings as read on the server, with `fields=known_as_values`.
 */
export function HierarchySettings({ hierarchy }: Readonly<{ hierarchy: OrgHierarchyResponse }>) {
  const t = useTranslations('console');
  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="mb-2 text-[13px] font-bold text-ink-900">{t('orgs.top_level_known_as')}</h3>
        <KnownAsValuesEditor
          orgId={hierarchy.network.id}
          values={hierarchy.network.known_as_values ?? []}
        />
      </section>
    </div>
  );
}
