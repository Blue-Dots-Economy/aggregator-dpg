'use client';

/**
 * Per-user grants on a coordinator (RBAC R3): show each grant the
 * coordinator's organisation allows (today PII Access), whether it is live and
 * until when, and grant or revoke it. The API applies the rules (reach, the
 * organisation's set, the longest validity) and audits every change.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type {
  PermissionGrant,
  RevokeGrantResponse,
  UserGrantsResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { errorKey, sendConsole } from '../../lib/console-client';

export function GrantsPanel({ userId, initial }: { userId: string; initial: UserGrantsResponse }) {
  const t = useTranslations('console');
  const [grants, setGrants] = useState<PermissionGrant[]>(initial.grants);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (initial.grantable.length === 0) return null;

  const liveOf = (key: string) => grants.find((g) => g.grant_key === key && g.live);

  async function grant(key: string) {
    setBusy(true);
    const r = await sendConsole<PermissionGrant>(`/api/console/user/grant/${userId}`, 'POST', {
      grant_key: key,
    });
    setBusy(false);
    if (r.ok) {
      setGrants((gs) => [
        r.data,
        ...gs.map((g) => (g.grant_key === key ? { ...g, live: false } : g)),
      ]);
      setNote(t('grants.saved'));
    } else {
      setNote(t(errorKey(r)));
    }
  }

  async function revoke(key: string) {
    setBusy(true);
    const r = await sendConsole<RevokeGrantResponse>(
      `/api/console/user/grant/revoke/${userId}`,
      'POST',
      { grant_key: key },
    );
    setBusy(false);
    if (r.ok) {
      setGrants((gs) => gs.map((g) => (g.grant_key === key ? { ...g, live: false } : g)));
      setNote(t('grants.saved'));
    } else {
      setNote(t(errorKey(r)));
    }
  }

  return (
    <Card className="p-4 flex flex-col gap-3 text-[13.5px]">
      <span className="bd-label">{t('grants.title')}</span>
      {initial.grantable.map((g) => {
        const live = liveOf(g.grant_key);
        return (
          <div key={g.grant_key} className="flex flex-wrap items-center gap-3">
            <span className="font-semibold">
              {g.grant_key === 'pii_access' ? t('grants.pii_access') : g.grant_key}
            </span>
            <span data-testid={`grant-${g.grant_key}`} className="text-ink-600">
              {live
                ? t('grants.active_until', { date: live.expires_at.slice(0, 10) })
                : t('grants.none')}
            </span>
            {live ? (
              <Button kind="danger" disabled={busy} onClick={() => void revoke(g.grant_key)}>
                {t('grants.revoke')}
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void grant(g.grant_key)}>
                {t('grants.grant', { days: g.max_days })}
              </Button>
            )}
          </div>
        );
      })}
      <span className="text-[12px] text-ink-500">{t('grants.hint')}</span>
      {note ? (
        <p role="status" className="text-ink-600">
          {note}
        </p>
      ) : null}
    </Card>
  );
}
