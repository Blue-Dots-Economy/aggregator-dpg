'use client';

/**
 * The network admin's organisation list (user & org Phase 5): approve /
 * reject a pending org, repair an active org's owner access. A decision made
 * elsewhere (409 ALREADY_DECIDED) updates the row in place (C10).
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type {
  OrgDecisionResponse,
  OrgSearchResponse,
  OwnerAccessResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { errorKey, sendConsole } from '../../lib/console-client';

type OrgRow = OrgSearchResponse['orgs'][number];

export function OrgsTable({ orgs }: { orgs: OrgRow[] }) {
  const t = useTranslations('console');
  const [rows, setRows] = useState(orgs);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const note = (id: string, text: string) => setNotes((n) => ({ ...n, [id]: text }));
  const setStatus = (id: string, status: OrgRow['status']) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));

  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusy(id);
    const r = await sendConsole<OrgDecisionResponse>(`/api/console/org/decision/${id}`, 'POST', {
      decision,
    });
    setBusy(null);
    if (r.ok) {
      setStatus(id, r.data.status);
      note(id, t('coordinator.decided'));
    } else if (r.error.code === 'ALREADY_DECIDED') {
      const status = r.error.fields?.['status'] as OrgRow['status'] | undefined;
      if (status) setStatus(id, status);
      note(id, t('coordinator.already', { status: status ? t(`status.${status}`) : '' }));
    } else {
      note(id, t(errorKey(r)));
    }
  }

  async function repair(id: string) {
    setBusy(id);
    const r = await sendConsole<OwnerAccessResponse>(`/api/console/org/repair/${id}`, 'POST', {});
    setBusy(null);
    note(id, r.ok ? t('orgs.repaired', { status: r.data.status }) : t(errorKey(r)));
  }

  if (rows.length === 0) return <p className="text-[13.5px] text-ink-600">{t('orgs.empty')}</p>;
  return (
    <table className="w-full text-[13.5px]">
      <tbody>
        {rows.map((o) => (
          <tr key={o.id} className="border-t border-(--bd-border) align-top">
            <td className="py-2">
              <Link className="text-primary-600 underline" href={`/console/orgs/${o.id}`}>
                {o.name}
              </Link>
              {notes[o.id] ? (
                <p role="status" className="text-[12.5px] text-ink-600 mt-1">
                  {notes[o.id]}
                </p>
              ) : null}
            </td>
            <td>{t(`status.${o.status}`)}</td>
            <td>
              {t('home.coordinators', { count: o.coordinator_count })} ·{' '}
              {t('home.pending', { count: o.pending_count })}
            </td>
            <td className="flex gap-2 py-2 justify-end">
              {o.status === 'pending' ? (
                <>
                  <Button disabled={busy === o.id} onClick={() => void decide(o.id, 'approve')}>
                    {t('orgs.approve')}
                  </Button>
                  <Button
                    kind="danger"
                    disabled={busy === o.id}
                    onClick={() => void decide(o.id, 'reject')}
                  >
                    {t('orgs.reject')}
                  </Button>
                </>
              ) : null}
              {o.status === 'active' && !o.is_default ? (
                <Button kind="ghost" disabled={busy === o.id} onClick={() => void repair(o.id)}>
                  {t('orgs.repair')}
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
