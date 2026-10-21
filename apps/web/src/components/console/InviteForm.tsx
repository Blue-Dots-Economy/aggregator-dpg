'use client';

/**
 * Invite coordinators (user & org Phase 5): one address per line into a
 * chosen organisation; shows what was sent, what was refused and who is
 * already in the organisation.
 */

import { useState, type SubmitEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { UserInviteResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { I } from '../../icons';
import { ConsoleSection } from './ConsoleUi';
import { errorKey, sendConsole } from '../../lib/console-client';

export function InviteForm({ orgs }: Readonly<{ orgs: Array<{ id: string; name: string }> }>) {
  const t = useTranslations('console');
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? '');
  const [text, setText] = useState('');
  const [result, setResult] = useState<UserInviteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const recipients = text
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((email) => ({ email }));
    if (recipients.length === 0) return;
    setBusy(true);
    setError(null);
    const r = await sendConsole<UserInviteResponse>('/api/console/user/invite', 'POST', {
      org_id: orgId,
      recipients,
    });
    setBusy(false);
    if (r.ok) {
      setResult(r.data);
      setText('');
    } else {
      setResult(null);
      setError(t(errorKey(r)));
    }
  }

  return (
    <ConsoleSection>
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="flex flex-col gap-4 max-w-2xl text-[13.5px]"
      >
        <label className="flex flex-col gap-1.5">
          <span className="bd-label">{t('invite.org')}</span>
          <select className="bd-input" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="bd-label">{t('invite.recipients')}</span>
          <textarea
            className="bd-input min-h-[140px]"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <span className="text-[12px] text-ink-500">{t('invite.recipients_hint')}</span>
        </label>
        <div>
          <Button type="submit" disabled={busy || !orgId} icon={<I.send size={15} />}>
            {t('invite.send')}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-rose-700">
            {error}
          </p>
        ) : null}
        {result ? (
          <output className="flex flex-col gap-1 rounded-[12px] bg-(--bd-primary-50) px-4 py-3 text-ink-700">
            <span>{t('invite.result', { sent: result.sent, resent: result.resent })}</span>
            {result.invalid.length ? (
              <span>
                {t('invite.invalid')} {result.invalid.map((i) => i.email).join(', ')}
              </span>
            ) : null}
            {result.existing.length ? (
              <span>
                {t('invite.existing')} {result.existing.map((i) => i.email).join(', ')}
              </span>
            ) : null}
          </output>
        ) : null}
      </form>
    </ConsoleSection>
  );
}
