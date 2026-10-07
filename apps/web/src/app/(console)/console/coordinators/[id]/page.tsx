/**
 * One coordinator (user & org Phase 5): contact (plain within reach, P5-8),
 * approve / reject a pending one, and change the domains served.
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { User } from '@aggregator-dpg/shared-primitives/user-org';
import { consoleRead } from '@/lib/console-api.server';
import { Card } from '@/components/ui/Card';
import { CoordinatorActions } from '@/components/console/CoordinatorActions';

interface ConfigPayload {
  domains?: Array<{ id: string; label: string }>;
}

/** The network's domains, from the public aggregator config (empty on failure). */
async function domains(): Promise<Array<{ id: string; label: string }>> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${base}/v1/aggregator-config`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const cfg = (await res.json()) as ConfigPayload;
    return (cfg.domains ?? []).map((d) => ({ id: d.id, label: d.label }));
  } catch {
    return [];
  }
}

export default async function ConsoleCoordinatorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations('console');
  const { id } = await params;
  const [user, domainList] = await Promise.all([
    consoleRead<User>(`/v1/user/read/${encodeURIComponent(id)}`),
    domains(),
  ]);
  return (
    <div className="flex flex-col gap-4">
      <Link className="text-primary-600 underline text-[13.5px]" href="/console/coordinators">
        {t('coordinator.back')}
      </Link>
      <h1 className="font-display text-[22px] font-bold text-ink-900">{user.name}</h1>
      <Card className="p-4 text-[13.5px] flex flex-col gap-1">
        <span>
          {t('account.name')}: {user.contact.name ?? '—'}
        </span>
        <span>
          {t('account.email')}: {user.contact.email}
        </span>
        <span>
          {t('account.phone')}: {user.contact.phone ?? '—'}
        </span>
      </Card>
      <CoordinatorActions user={user} domains={domainList} />
    </div>
  );
}
