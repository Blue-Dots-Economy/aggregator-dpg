'use client';

/**
 * Invites coordinators to an organisation. Addresses are typed or pasted into
 * a chip box, up to the per-send cap; each valid address can carry an optional
 * name for the email greeting. Invalid addresses block sending until they are
 * fixed or removed; reloading or closing the page with unsent emails asks
 * first. After sending, one line says how many invites went out and
 * why the rest did not. A side card explains the steps and the per-send limit.
 */

import { useState, type SubmitEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Info } from 'lucide-react';
import { UserInviteResponseSchema } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '@/components/ui/Button';
import { I } from '@/icons';
import { ConsoleSection } from './ConsoleUi';
import { RESPONSE_SHAPE_CODE, sendConsole } from '@/lib/console-client';
import { DEFAULT_MAX_INVITES } from '@/lib/invite-limit';
import { useLeaveWarning } from '@/hooks/useLeaveWarning';
import { failureKey, notSentOf, type InviteResult } from './invite/invite-recipients';
import { HelpCard } from './invite/InviteHelpCard';
import { CountMeter, InvalidBanner, LimitNote } from './invite/InviteNotices';
import { NamesList } from './invite/NamesList';
import { OrgHeader } from './invite/OrgHeader';
import { RecipientBox } from './invite/RecipientBox';
import { ResultBanner } from './invite/ResultBanner';
import { useRecipientList } from './invite/useRecipientList';

export { parseRecipients } from './invite/invite-recipients';

/** The invite form beside its help card. */
export function InviteForm({
  orgs,
  maxRecipients = DEFAULT_MAX_INVITES,
  coordinatorsHref = null,
}: Readonly<{
  orgs: Array<{ id: string; name: string }>;
  /** Per-send cap (`INVITE_MAX_RECIPIENTS`), read by the page on the server. */
  maxRecipients?: number;
  /** Link to the coordinators list, or `null` when the actor cannot open it. */
  coordinatorsHref?: string | null;
}>) {
  const t = useTranslations('console');
  const router = useRouter();
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? '');
  const list = useRecipientList(maxRecipients);
  const { draft, recipients, skipped } = list;
  const [result, setResult] = useState<InviteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const valid = recipients.filter((r) => r.valid);
  const invalidCount = recipients.length - valid.length;
  const full = recipients.length >= maxRecipients;

  useLeaveWarning(recipients.length > 0 || draft.trim() !== '');

  function add(text: string) {
    list.add(text);
    setResult(null);
  }

  function remove(email: string) {
    list.remove(email);
    setResult(null);
  }

  function edit(email: string) {
    list.edit(email);
    setResult(null);
  }

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const { all, skipped: skippedNow } = list.collectForSend();
    // Nothing valid, or an invalid address still in the list: show the list and its message.
    if (!all.some((r) => r.valid) || all.some((r) => !r.valid)) {
      list.update(all, skippedNow);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await sendConsole('/api/console/user/invite', 'POST', UserInviteResponseSchema, {
      org_id: orgId,
      recipients: all.map((x) =>
        x.name.trim() ? { email: x.email, name: x.name.trim() } : { email: x.email },
      ),
    });
    setBusy(false);
    if (r.ok) {
      setResult({ sent: r.data.sent + r.data.resent, notSent: notSentOf(r.data) });
      list.update([]);
    } else if (r.error.code === RESPONSE_SHAPE_CODE) {
      // The invites may have been sent: clear the list so a second click does not resend them.
      list.update([]);
      setResult(null);
      setError(t(failureKey(r)));
      router.refresh();
    } else {
      list.update(all, skippedNow);
      setResult(null);
      setError(t(failureKey(r)));
    }
  }

  let footNote: string | null = null;
  if (recipients.length === 0 && !draft.trim()) footNote = t('invite.note_empty');
  else if (invalidCount) footNote = t('invite.note_fix');

  let sendLabel = t('invite.send');
  if (busy) sendLabel = t('invite.sending');
  else if (valid.length) sendLabel = t('invite.send_count', { count: valid.length });

  let placeholder = t('invite.placeholder');
  if (full) placeholder = t('invite.limit_reached');
  else if (recipients.length) placeholder = t('invite.add_more');

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <ConsoleSection flush className="min-w-0 overflow-visible">
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col text-[13.5px]" noValidate>
          <OrgHeader orgs={orgs} orgId={orgId} onChange={setOrgId} />

          <div className="flex flex-1 flex-col gap-2.5 p-[22px]">
            {result ? <ResultBanner result={result} onDismiss={() => setResult(null)} /> : null}

            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor="invite-emails" className="text-[14px] font-bold text-ink-900">
                {t('invite.recipients')}
              </label>
              <CountMeter count={recipients.length} max={maxRecipients} />
            </div>

            <RecipientBox
              recipients={recipients}
              draft={draft}
              full={full}
              placeholder={placeholder}
              onDraft={list.changeDraft}
              onAdd={add}
              onRemove={remove}
              onEdit={edit}
            />

            {full ? <LimitNote skipped={skipped} max={maxRecipients} /> : null}

            {invalidCount ? (
              <InvalidBanner count={invalidCount} onRemove={() => list.update(valid)} />
            ) : null}

            {valid.length ? (
              <NamesList people={valid} onName={list.setName} onRemove={remove} />
            ) : null}

            {error ? (
              <p role="alert" className="text-rose-700">
                {error}
              </p>
            ) : null}
          </div>

          <footer className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-b-[14px] border-t border-(--bd-border-soft) bg-(--bd-bg) px-[22px] py-4">
            {footNote ? (
              <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-500">
                <Info size={14} aria-hidden="true" className="shrink-0" />
                {footNote}
              </span>
            ) : null}
            <div className="ml-auto flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
              {recipients.length ? (
                <Button
                  kind="ghost"
                  onClick={() => list.update([])}
                  className="w-full justify-center sm:w-auto"
                >
                  {t('invite.clear')}
                </Button>
              ) : null}
              <Button
                type="submit"
                disabled={
                  busy || !orgId || invalidCount > 0 || (valid.length === 0 && !draft.trim())
                }
                icon={<I.send size={15} />}
                className="w-full justify-center sm:w-auto"
              >
                {sendLabel}
              </Button>
            </div>
          </footer>
        </form>
      </ConsoleSection>

      <HelpCard maxRecipients={maxRecipients} coordinatorsHref={coordinatorsHref} />
    </div>
  );
}
