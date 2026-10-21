'use client';

/**
 * The network admin's organisation list (user & org Phase 5): each name opens
 * the organisation, and a pending org is approved or rejected in place. A
 * decision made elsewhere (409 ALREADY_DECIDED) updates the row in place
 * (C10). Owner access is repaired from the organisation's page.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type {
  OrgDecisionResponse,
  OrgSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { ConsoleStatusPill, EmptyState } from './ConsoleUi';
import { errorKey, sendConsole } from '../../lib/console-client';

type OrgRow = OrgSearchResponse['orgs'][number];

export function OrgsTable({ orgs }: Readonly<{ orgs: OrgRow[] }>) {
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

  // Decisions are the only row actions; the column shows while one is pending
  // or a decision has just been made.
  const showActions = rows.some((r) => r.status === 'pending' || notes[r.id]);

  if (rows.length === 0) return <EmptyState>{t('orgs.empty')}</EmptyState>;
  return (
    <div className="overflow-x-auto scroll-x">
      <table className="bd-table">
        <thead>
          <tr>
            <th>{t('orgs.col_name')}</th>
            <th>{t('orgs.col_status')}</th>
            <th>{t('orgs.col_counts')}</th>
            {showActions ? <th style={{ textAlign: 'right' }}>{t('orgs.col_actions')}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td>
                <Link
                  className="font-semibold text-primary-600 hover:underline"
                  href={`/console/orgs/${o.id}`}
                >
                  {o.name}
                </Link>
                {notes[o.id] ? (
                  <output className="text-[12.5px] text-ink-500 mt-1 block whitespace-normal">
                    {notes[o.id]}
                  </output>
                ) : null}
              </td>
              <td>
                <ConsoleStatusPill status={o.status} />
              </td>
              <td className="text-ink-600">
                {t('home.coordinators', { count: o.coordinator_count })} ·{' '}
                {t('home.pending', { count: o.pending_count })}
              </td>
              {showActions ? (
                <td>
                  {o.status === 'pending' ? (
                    <div className="flex gap-2 justify-end">
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
                    </div>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
