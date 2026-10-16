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
import { I } from '../../icons';
import { ConsoleSection } from './ConsoleUi';
import { errorKey, sendConsole } from '../../lib/console-client';

/** Code-unit order, as `sort()` without a compare function; locale-independent. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

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
  ].sort(compareCodeUnits);

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
    <ConsoleSection title={title ?? t('roles.title')}>
      <div className="flex flex-col gap-4 text-[13.5px]">
        {base.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {base.map((b) => (
              <span
                key={b.role_key}
                data-testid={`role-base-${b.role_key}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-(--bd-primary-50) text-primary-600 px-3 py-1 text-[12.5px] font-semibold"
              >
                <I.shield size={13} />
                {t('roles.base', { role: nameOf(b.role_key) })}
              </span>
            ))}
          </div>
        ) : null}
        {shown.length > 0 ? (
          <ul className="rounded-[12px] border border-(--bd-border)">
            {shown.map((key) => {
              const live = liveOf(key);
              const days = maxDaysOf(key);
              return (
                <li
                  key={key}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-(--bd-border-soft) last:border-b-0"
                >
                  <span className="font-semibold text-ink-900 min-w-[140px]">{nameOf(key)}</span>
                  <span
                    data-testid={`role-${key}`}
                    className={live ? 'text-emerald-700' : 'text-ink-500'}
                  >
                    {live
                      ? live.expires_at
                        ? t('roles.until', { date: live.expires_at.slice(0, 10) })
                        : t('roles.no_expiry')
                      : t('roles.none')}
                  </span>
                  <span className="ml-auto">
                    {live ? (
                      assignable.has(key) ? (
                        <Button kind="danger" disabled={busy} onClick={() => void revoke(key)}>
                          {t('roles.revoke')}
                        </Button>
                      ) : null
                    ) : (
                      <Button kind="soft" disabled={busy} onClick={() => void assign(key)}>
                        {days ? t('roles.assign_for', { days }) : t('roles.assign')}
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <span className="text-[12px] text-ink-500">{t('roles.hint')}</span>
        {note ? (
          <p role="status" className="text-ink-600">
            {note}
          </p>
        ) : null}
      </div>
    </ConsoleSection>
  );
}
