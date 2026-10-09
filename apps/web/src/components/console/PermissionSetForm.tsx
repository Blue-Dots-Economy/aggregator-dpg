'use client';

/**
 * An organisation's own PermissionSet (RBAC R3, network admin): choose one of
 * the instance's sets, or the default for the organisation type. The API
 * checks that only a parent sets a child's set, and audits the change.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { OrgPermissionSetResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { errorKey, sendConsole } from '../../lib/console-client';

export function PermissionSetForm({
  orgId,
  current,
  sets,
  defaultName,
}: {
  orgId: string;
  current: string | null;
  sets: string[];
  defaultName: string;
}) {
  const t = useTranslations('console');
  const [value, setValue] = useState<string>(current ?? '');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const r = await sendConsole<OrgPermissionSetResponse>(
      `/api/console/org/permission-set/${orgId}`,
      'PATCH',
      { permission_set: value === '' ? null : value },
    );
    setBusy(false);
    setNote(r.ok ? t('org.permission_set_saved') : t(errorKey(r)));
  }

  return (
    <Card className="p-4 flex flex-col gap-2 text-[13.5px]">
      <label className="flex flex-col gap-1">
        <span className="bd-label">{t('org.permission_set')}</span>
        <select
          className="bd-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={t('org.permission_set')}
        >
          <option value="">{t('org.permission_set_default', { name: defaultName })}</option>
          {sets.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <Button kind="ghost" disabled={busy} onClick={() => void save()}>
          {t('org.permission_set_save')}
        </Button>
        {note ? (
          <span role="status" className="text-ink-600">
            {note}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
