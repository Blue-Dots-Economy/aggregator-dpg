/**
 * Organisations page.
 *
 * An org owner sees its own organisations, each as a tree with every
 * organisation below it (read-only below its own); names open each page.
 *
 * The network admin sees the whole network:
 * Shows the organisations awaiting approval (approved or rejected in place),
 * every organisation as a tree under the network (each name opens the
 * organisation's page) with its "known as" name and depth, and, closed by
 * default, the hierarchy settings.
 */

import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { OrgHierarchyResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { readNetworkOrgs, readReachableOrgs } from '@/lib/console-hierarchy.server';
import { orgsBelow, topmostOwned } from '@/lib/console-org-options';
import { OrgsTable } from '@/components/console/OrgsTable';
import { HierarchySettings } from '@/components/console/HierarchySettings';
import { ChildOrgsTree } from '@/components/console/ChildOrgsTree';
import { ConsoleCollapsible, ConsoleSection } from '@/components/console/ConsoleUi';
import { Topbar } from '@/components/shell/Topbar';

export default async function ConsoleOrgsPage() {
  const t = await getTranslations('console');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  if (!actor.me.is_network_admin) return <OwnerOrgs ownedIds={actor.me.orgs.map((o) => o.id)} />;
  const hierarchy = await consoleRead<OrgHierarchyResponse>('/v1/org/hierarchy');
  const network = await readNetworkOrgs(hierarchy.network.id);
  const pending = network.orgs.filter((o) => o.status === 'pending');
  return (
    <>
      <Topbar title={t('orgs.heading')} subtitle={t('orgs.subtitle')} />
      <div className="flex flex-col gap-6">
        {pending.length > 0 ? (
          <div id="pending" className="scroll-mt-6">
            <ConsoleSection title={t('orgs.pending', { count: pending.length })} flush>
              <OrgsTable orgs={pending} />
            </ConsoleSection>
          </div>
        ) : null}
        <ConsoleSection title={t('orgs.network')}>
          <ChildOrgsTree
            rootId={hierarchy.network.id}
            rootName={hierarchy.network.name}
            rootKnownAs={null}
            rootTag={t('orgs.network_tag')}
            orgs={network.orgs}
            linkRows
            more={network.more}
          />
        </ConsoleSection>
        <ConsoleCollapsible
          title={t('orgs.hierarchy')}
          hint={t('orgs.hierarchy_summary', {
            total: hierarchy.total_orgs,
            max: hierarchy.limits.max_total_orgs,
          })}
        >
          <HierarchySettings hierarchy={hierarchy} />
        </ConsoleCollapsible>
      </div>
    </>
  );
}

/**
 * An owner's view: one tree per topmost owned organisation, with everything
 * below it.
 *
 * @param ownedIds - The organisations the owner owns.
 */
async function OwnerOrgs({ ownedIds }: Readonly<{ ownedIds: string[] }>) {
  const t = await getTranslations('console');
  const orgs = await readReachableOrgs();
  const roots = topmostOwned(ownedIds, orgs);
  if (roots.length === 0) redirect('/console');
  return (
    <>
      <Topbar title={t('orgs.heading')} subtitle={t('orgs.subtitle_owner')} />
      <div className="flex flex-col gap-6">
        {roots.map((root) => (
          <ConsoleSection key={root.id} title={root.name}>
            <ChildOrgsTree
              rootId={root.id}
              rootName={root.name}
              rootKnownAs={root.known_as_name ?? root.known_as}
              rootTag={t('orgs.yours')}
              orgs={orgsBelow(root.id, orgs)}
              linkRows
              more={false}
            />
          </ConsoleSection>
        ))}
      </div>
    </>
  );
}
