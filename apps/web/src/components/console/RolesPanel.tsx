'use client';

/**
 * A user's roles in one organisation (RBAC; design §4): the base role that
 * membership gives, and the additional roles the caller may assign or revoke
 * (PII Access and Data Export for a coordinator, Org Onboarder for an owner,
 * custom roles). The API applies every rule and audits every change.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type {
  Role,
  RoleAssignment,
  RevokeRoleResponse,
  UserRolesResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { errorKey, sendConsole } from '../../lib/console-client';

export function RolesPanel({
  userId,
  orgId,
  initial,
  roles,
  title,
}: {
  userId: string;
  orgId: string;
  initial: UserRolesResponse;
  roles: Role[];
  title?: string;
}) {
  const t = useTranslations('console');
  const [additional, setAdditional] = useState<RoleAssignment[]>(initial.additional);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameOf = (key: string) => roles.find((r) => r.key === key)?.name ?? key;
  const maxDaysOf = (key: string) => roles.find((r) => r.key === key)?.max_days ?? null;
  const base = initial.base.filter((b) => b.org_id === orgId);
  const assignable = new Set(
    initial.assignable.filter((a) => a.org_id === orgId).map((a) => a.role_key),
  );
  const liveOf = (key: string) =>
    additional.find((a) => a.role_key === key && a.org_id === orgId && a.live);
  const shown = [
    ...new Set([
      ...assignable,
      ...additional.filter((a) => a.org_id === orgId && a.live).map((a) => a.role_key),
    ]),
  ].sort();

  if (base.length === 0 && shown.length === 0) return null;

  async function assign(key: string) {
    setBusy(true);
    const r = await sendConsole<RoleAssignment>(`/api/console/user/role/assign/${userId}`, 'POST', {
      role_key: key,
      org_id: orgId,
    });
    setBusy(false);
    if (r.ok) {
      setAdditional((as) => [
        r.data,
        ...as.map((a) => (a.role_key === key && a.org_id === orgId ? { ...a, live: false } : a)),
      ]);
      setNote(t('roles.saved'));
    } else {
      setNote(t(errorKey(r)));
    }
  }

  async function revoke(key: string) {
    setBusy(true);
    const r = await sendConsole<RevokeRoleResponse>(
      `/api/console/user/role/revoke/${userId}`,
      'POST',
      { role_key: key, org_id: orgId },
    );
    setBusy(false);
    if (r.ok) {
      setAdditional((as) =>
        as.map((a) => (a.role_key === key && a.org_id === orgId ? { ...a, live: false } : a)),
      );
      setNote(t('roles.saved'));
    } else {
      setNote(t(errorKey(r)));
    }
  }

  return (
    <Card className="p-4 flex flex-col gap-3 text-[13.5px]">
      <span className="bd-label">{title ?? t('roles.title')}</span>
      {base.map((b) => (
        <span key={b.role_key} data-testid={`role-base-${b.role_key}`} className="text-ink-600">
          {t('roles.base', { role: nameOf(b.role_key) })}
        </span>
      ))}
      {shown.map((key) => {
        const live = liveOf(key);
        const days = maxDaysOf(key);
        return (
          <div key={key} className="flex flex-wrap items-center gap-3">
            <span className="font-semibold">{nameOf(key)}</span>
            <span data-testid={`role-${key}`} className="text-ink-600">
              {live
                ? live.expires_at
                  ? t('roles.until', { date: live.expires_at.slice(0, 10) })
                  : t('roles.no_expiry')
                : t('roles.none')}
            </span>
            {live ? (
              assignable.has(key) ? (
                <Button kind="danger" disabled={busy} onClick={() => void revoke(key)}>
                  {t('roles.revoke')}
                </Button>
              ) : null
            ) : (
              <Button disabled={busy} onClick={() => void assign(key)}>
                {days ? t('roles.assign_for', { days }) : t('roles.assign')}
              </Button>
            )}
          </div>
        );
      })}
      <span className="text-[12px] text-ink-500">{t('roles.hint')}</span>
      {note ? (
        <p role="status" className="text-ink-600">
          {note}
        </p>
      ) : null}
    </Card>
  );
}
