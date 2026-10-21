'use client';

/**
 * Coordinator actions: approve or reject a pending coordinator (optional
 * reason, emailed to the applicant) and change the domains served. A 409
 * ALREADY_DECIDED response updates the status in place. The decision card
 * shows only while pending or just decided. A viewer who cannot manage the
 * coordinator's organisation sees the domains read-only and no actions.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { DecisionResponse, User } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { I } from '../../icons';
import { ConsoleSection, ConsoleStatusPill } from './ConsoleUi';
import { errorKey, sendConsole } from '../../lib/console-client';

export function CoordinatorActions({
  user,
  domains,
  readOnly = false,
}: Readonly<{
  user: User;
  domains: Array<{ id: string; label: string }>;
  /** Show status and domains only, with no decision or domain editing. */
  readOnly?: boolean;
}>) {
  const t = useTranslations('console');
  const router = useRouter();
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
      router.refresh();
    } else if (r.error.code === 'ALREADY_DECIDED') {
      const now = r.error.fields?.['status'] as User['status'] | undefined;
      if (now) setStatus(now);
      setDecisionNote(t('coordinator.already', { status: now ? t(`status.${now}`) : '' }));
      router.refresh();
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
    <div className="flex flex-col gap-6">
      {!readOnly && (status === 'pending' || decisionNote) ? (
        <ConsoleSection
          title={t('coordinator.decision')}
          action={
            <span data-testid="coordinator-status">
              <ConsoleStatusPill status={status} />
            </span>
          }
        >
          <div className="flex flex-col gap-4 text-[13.5px] max-w-2xl">
            {status === 'pending' ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="bd-label">{t('coordinator.reason')}</span>
                  <textarea
                    className="bd-input min-h-[80px]"
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <div className="flex gap-2">
                  <Button
                    disabled={busy}
                    icon={<I.check size={15} />}
                    onClick={() => void decide('approve')}
                  >
                    {t('coordinator.approve')}
                  </Button>
                  <Button
                    kind="danger"
                    disabled={busy}
                    icon={<I.x size={15} />}
                    onClick={() => void decide('reject')}
                  >
                    {t('coordinator.reject')}
                  </Button>
                </div>
              </>
            ) : null}
            {decisionNote ? <output className="text-ink-600">{decisionNote}</output> : null}
          </div>
        </ConsoleSection>
      ) : null}

      {readOnly && domains.length > 0 ? (
        <ConsoleSection title={t('coordinator.domains')}>
          <p className="text-[13.5px] text-ink-700">
            {serves.length
              ? domains
                  .filter((d) => serves.includes(d.id))
                  .map((d) => d.label)
                  .join(', ')
              : t('coordinators.every_domain')}
          </p>
        </ConsoleSection>
      ) : null}

      {!readOnly && domains.length > 0 ? (
        <ConsoleSection title={t('coordinator.domains')}>
          <div className="flex flex-col gap-3 text-[13.5px]">
            <div className="flex flex-wrap gap-2">
              {domains.map((d) => (
                <label
                  key={d.id}
                  className="inline-flex items-center gap-2 rounded-[10px] border border-(--bd-border) px-3 py-2 cursor-pointer hover:bg-(--bd-border-soft)"
                >
                  <input
                    type="checkbox"
                    className="w-4 h-4"
                    style={{ accentColor: 'var(--bd-primary-600)' }}
                    checked={serves.includes(d.id)}
                    onChange={() => toggle(d.id)}
                  />
                  {d.label}
                </label>
              ))}
            </div>
            <span className="text-[12px] text-ink-500">{t('coordinator.domains_hint')}</span>
            <div className="flex items-center gap-3">
              <Button kind="soft" disabled={busy} onClick={() => void saveServes()}>
                {t('coordinator.save_domains')}
              </Button>
              {servesNote ? <output className="text-ink-600">{servesNote}</output> : null}
            </div>
          </div>
        </ConsoleSection>
      ) : null}
    </div>
  );
}
