/**
 * Invites organisations to register under an organisation the caller owns:
 * the network for the network admin, else its own active organisations.
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getConsoleActor } from '@/lib/console-actor';
import { canOnboardOrgsUnder } from '@/lib/capabilities';
import { getAggregatorFeatures } from '@/lib/features.server';
import { resolveMaxInvites } from '@/lib/invite-limit';
import { InviteForm } from '@/components/console/InviteForm';
import { ConsoleSection } from '@/components/console/ConsoleUi';
import { Topbar } from '@/components/shell/Topbar';

/** The organisations listed as "Onboarded Organisations". */
const ORGS_HREF = '/console/orgs';

export default async function ConsoleOrgInvitePage() {
  const t = await getTranslations('console');
  const actor = await getConsoleActor();
  if (!actor.ok) return null;
  const parents = actor.me.orgs
    .filter((o) => o.role === 'owner' && canOnboardOrgsUnder(actor.me, o))
    .map((o) => ({ id: o.id, name: o.name }));
  const { invite_role_label: roleLabel } = await getAggregatorFeatures();
  return (
    <>
      <nav aria-label={t('invite.breadcrumb')} className="mb-3 text-[13px]">
        <ol className="flex items-center gap-1.5 text-(--bd-fg-muted)">
          <li>
            <Link href={ORGS_HREF} className="font-medium text-primary-600 hover:underline">
              {t('invite.org.breadcrumb_parent')}
            </Link>
          </li>
          <li aria-hidden>›</li>
          <li aria-current="page">{t('invite.breadcrumb_current')}</li>
        </ol>
      </nav>
      <Topbar title={t('invite.org.heading')} subtitle={t('invite.org.subtitle')} />
      <div className="flex flex-col gap-6">
        {parents.length === 0 ? (
          <ConsoleSection>
            <p className="text-[13.5px] text-ink-500">{t('invite.no_orgs')}</p>
          </ConsoleSection>
        ) : (
          <InviteForm
            orgs={parents}
            maxRecipients={resolveMaxInvites()}
            coordinatorsHref={ORGS_HREF}
            target={{ kind: 'org', roleLabel: roleLabel ?? t('invite.org.role_default') }}
          />
        )}
      </div>
    </>
  );
}
