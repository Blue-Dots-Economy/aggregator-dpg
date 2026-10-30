/**
 * Organisations page.
 *
 * An org owner sees its own organisations, each as a tree with every
 * organisation below it (read-only below its own); names open each page.
 *
 * The network admin sees the whole network: the organisations awaiting
 * approval (approved or rejected in place), status tiles, every organisation
 * as a tree under the network or as a searchable list (each name opens the
 * organisation's page), and, closed by default, the hierarchy settings.
 * `?view=list` and `?status=` open the list with a filter.
 */

import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
import type { OrgHierarchyResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { readNetworkOrgs, readReachableOrgs } from '@/lib/console-hierarchy.server';
import { orgsBelow, topmostOwned } from '@/lib/console-org-options';
import { OrgsTable } from '@/components/console/OrgsTable';
import { HierarchySettings } from '@/components/console/HierarchySettings';
import { ChildOrgsTree } from '@/components/console/ChildOrgsTree';
import { NetworkOrgsView } from '@/components/console/NetworkOrgsView';
import { ORG_FILTERS, type OrgFilter } from '@/lib/org-filters';
import { ConsoleCollapsible, ConsoleSection } from '@/components/console/ConsoleUi';
import { Topbar } from '@/components/shell/Topbar';

export default async function ConsoleOrgsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ view?: string; status?: string }> }>) {
  const t = await getTranslations('console');
  const params = await searchParams;
  const initialFilter: OrgFilter = ORG_FILTERS.find((f) => f === params.status) ?? 'all';
  const initialView = params.view === 'list' || params.status ? 'list' : 'tree';
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
            <ConsoleSection title={t('orgs.review_heading', { count: pending.length })} flush>
              <OrgsTable orgs={pending} />
            </ConsoleSection>
          </div>
        ) : null}
        <NetworkOrgsView
          rootName={hierarchy.network.name}
          orgs={network.orgs}
          more={network.more}
          totalOrgs={hierarchy.total_orgs}
          maxOrgs={hierarchy.limits.max_total_orgs}
          initialView={initialView}
          initialFilter={initialFilter}
        />
        <ConsoleCollapsible
          title={t('orgs.hierarchy')}
          hint={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-(--bd-border-soft) px-2.5 py-0.5 text-[12px] font-semibold text-ink-500">
              <Lock size={12} aria-hidden="true" />
              {t('orgs.read_only')}
            </span>
          }
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
