'use client';

/**
 * Coordinator actions (user & org Phase 5): approve / reject a pending one
 * (optional reason, mailed to the applicant) and change the domains served.
 * A decision made elsewhere (409 ALREADY_DECIDED) updates the status in place
 * (C10).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { DecisionResponse, User } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { errorKey, sendConsole } from '../../lib/console-client';

export function CoordinatorActions({
  user,
  domains,
}: {
  user: User;
  domains: Array<{ id: string; label: string }>;
}) {
  const t = useTranslations('console');
  const [status, setStatus] = useState(user.status);
  const [reason, setReason] = useState('');
  const [serves, setServes] = useState<string[]>(user.serves);
  const [decisionNote, setDecisionNote] = useState<string | null>(null);
  const [servesNote, setServesNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    const body =
      decision === 'reject' && reason.trim() ? { decision, reason: reason.trim() } : { decision };
    const r = await sendConsole<DecisionResponse>(
      `/api/console/user/decision/${user.id}`,
      'POST',
      body,
    );
    setBusy(false);
    if (r.ok) {
      setStatus(r.data.status);
      setDecisionNote(t('coordinator.decided'));
    } else if (r.error.code === 'ALREADY_DECIDED') {
      const now = r.error.fields?.['status'] as User['status'] | undefined;
      if (now) setStatus(now);
      setDecisionNote(t('coordinator.already', { status: now ? t(`status.${now}`) : '' }));
    } else {
      setDecisionNote(t(errorKey(r)));
    }
  }

  async function saveServes() {
    setBusy(true);
    const r = await sendConsole<User>(`/api/console/user/metadata/${user.id}`, 'PATCH', { serves });
    setBusy(false);
    if (r.ok) setServes(r.data.serves);
    setServesNote(r.ok ? t('coordinator.saved') : t(errorKey(r)));
  }

  const toggle = (id: string) =>
    setServes((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4 flex flex-col gap-3 text-[13.5px]">
        <span data-testid="coordinator-status">
          {t('coordinators.status')}: {t(`status.${status}`)}
        </span>
        {status === 'pending' ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="bd-label">{t('coordinator.reason')}</span>
              <textarea
                className="bd-input min-h-[70px]"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void decide('approve')}>
                {t('coordinator.approve')}
              </Button>
              <Button kind="danger" disabled={busy} onClick={() => void decide('reject')}>
                {t('coordinator.reject')}
              </Button>
            </div>
          </>
        ) : null}
        {decisionNote ? (
          <p role="status" className="text-ink-600">
            {decisionNote}
          </p>
        ) : null}
      </Card>

      {domains.length > 0 ? (
        <Card className="p-4 flex flex-col gap-2 text-[13.5px]">
          <span className="bd-label">{t('coordinator.domains')}</span>
          {domains.map((d) => (
            <label key={d.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={serves.includes(d.id)}
                onChange={() => toggle(d.id)}
              />
              {d.label}
            </label>
          ))}
          <span className="text-[12px] text-ink-500">{t('coordinator.domains_hint')}</span>
          <div className="flex items-center gap-3">
            <Button kind="ghost" disabled={busy} onClick={() => void saveServes()}>
              {t('coordinator.save_domains')}
            </Button>
            {servesNote ? (
              <span role="status" className="text-ink-600">
                {servesNote}
              </span>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
