'use client';

/**
 * Coordinator actions: change the domains served. Domains can be changed while
 * the coordinator is pending or active; a rejected or retired coordinator's
 * domains, and every coordinator for a viewer who cannot manage its
 * organisation, are shown read-only.
 *
 * Domains are the network's configured domains; a saved id the network no
 * longer has is not shown and is dropped on the next save. A coordinator saved
 * with none serves nothing, so none is ticked. A save bar appears once the
 * choice differs from what is saved, and at least one domain must stay ticked.
 * A save that removes a saved domain asks for confirmation first. Saving ends
 * the coordinator's sessions; its next sign-in carries the new domains.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Tag } from 'lucide-react';
import { UserSchema, type User } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';
import { DomainChips } from './DomainChips';
import { sendConsole, type ConsoleError } from '../../lib/console-client';
import { plainErrorKey } from '../../lib/console-errors';

/** API error codes with their own message on this page. */
const ACTION_ERROR_CODES = { TARGET_ORG_INACTIVE: 'org_inactive' } as const;

/** The message key for a failed domains save. */
function actionErrorKey(r: { status: number; error: ConsoleError }): string {
  return plainErrorKey(r, 'coordinator', ACTION_ERROR_CODES);
}

/** Whether two id lists hold the same ids, in any order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** The saved domains the network still has, in network order. */
function tickedIds(serves: readonly string[], domains: ReadonlyArray<{ id: string }>): string[] {
  return domains.filter((d) => serves.includes(d.id)).map((d) => d.id);
}

/** The list with `id` added, or removed when it is already there. */
function toggled(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export function CoordinatorActions({
  user,
  domains,
  readOnly = false,
}: Readonly<{
  user: User;
  domains: Array<{ id: string; label: string }>;
  /** Show the domains only, with no editing. */
  readOnly?: boolean;
}>) {
  const t = useTranslations('console');
  const ticked = (serves: readonly string[]) => tickedIds(serves, domains);
  const [saved, setSaved] = useState<string[]>(() => ticked(user.serves));
  const [chosen, setChosen] = useState<string[]>(() => ticked(user.serves));
  const [servesNote, setServesNote] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [busy, setBusy] = useState(false);

  const dirty = !sameIds(chosen, saved);
  const empty = chosen.length === 0;
  const editable = !readOnly && (user.status === 'pending' || user.status === 'active');
  const removed = domains.filter((d) => saved.includes(d.id) && !chosen.includes(d.id));

  function toggle(id: string) {
    setServesNote(null);
    setConfirmingRemoval(false);
    setChosen((c) => toggled(c, id));
  }

  /** The save bar's message: an empty choice, a removal to confirm, or unsaved changes. */
  function barNote(): string {
    if (empty) return t('coordinator.domains_empty');
    if (confirmingRemoval) {
      return t('coordinator.remove_domains_note', {
        domains: removed.map((d) => d.label).join(', '),
      });
    }
    return t('coordinator.unsaved');
  }

  function discard() {
    setChosen(saved);
    setServesNote(null);
    setConfirmingRemoval(false);
  }

  async function saveServes() {
    if (empty) {
      document.querySelector<HTMLInputElement>('#coordinator-domains input')?.focus();
      return;
    }
    if (removed.length > 0 && !confirmingRemoval) {
      setConfirmingRemoval(true);
      return;
    }
    setConfirmingRemoval(false);
    setBusy(true);
    const r = await sendConsole(`/api/console/user/metadata/${user.id}`, 'PATCH', UserSchema, {
      serves: ticked(chosen),
    });
    setBusy(false);
    if (!r.ok) {
      setServesNote(t(actionErrorKey(r)));
      return;
    }
    setSaved(ticked(r.data.serves));
    setChosen(ticked(r.data.serves));
    setServesNote(t('coordinator.domains_saved'));
  }

  return (
    <div className="flex flex-col gap-6">
      {domains.length > 0 ? (
        <section className="bd-card bd-shadow">
          <header className="px-[22px] pt-[18px]">
            <h2 className="font-display text-[16px] font-bold text-ink-900">
              {t('coordinator.domains')}
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-500">{t('coordinator.domains_sub')}</p>
          </header>
          <div className="flex flex-col gap-3.5 px-[22px] pt-4 pb-[22px] text-[13.5px]">
            {editable ? (
              <>
                <fieldset
                  id="coordinator-domains"
                  aria-label={t('coordinator.domains')}
                  aria-invalid={(dirty && empty) || undefined}
                  aria-describedby="coordinator-domains__error"
                  className="m-0 min-w-0 border-0 p-0 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5"
                >
                  {domains.map((d) => (
                    <DomainOption
                      key={d.id}
                      label={d.label}
                      on={chosen.includes(d.id)}
                      onToggle={() => toggle(d.id)}
                    />
                  ))}
                </fieldset>

                {dirty ? (
                  <SaveBar
                    empty={empty}
                    busy={busy}
                    note={barNote()}
                    confirmingRemoval={confirmingRemoval}
                    onCancelRemoval={() => setConfirmingRemoval(false)}
                    onDiscard={discard}
                    onSave={() => void saveServes()}
                  />
                ) : null}
                {servesNote ? (
                  <output className="text-[13px] text-ink-600">{servesNote}</output>
                ) : null}
              </>
            ) : (
              <DomainChips domains={domains.filter((d) => saved.includes(d.id))} />
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** One domain as a ticked or unticked card in the editable list. */
function DomainOption({
  label,
  on,
  onToggle,
}: Readonly<{ label: string; on: boolean; onToggle: () => void }>) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-[12px] border-[1.5px] border-(--bd-border) bg-(--bd-card) p-3.5 transition-colors hover:border-ink-400 focus-within:shadow-[0_0_0_3px_var(--bd-primary-50)]',
        on && 'border-(--bd-primary) bg-(--bd-primary-50) hover:border-(--bd-primary)',
      )}
    >
      <input type="checkbox" className="sr-only" checked={on} onChange={onToggle} />
      <span
        aria-hidden="true"
        className={cn(
          'grid h-5 w-5 flex-none place-items-center rounded-md border-[1.5px] border-(--bd-border) bg-(--bd-card) text-white',
          on && 'border-(--bd-primary) bg-(--bd-primary)',
        )}
      >
        {on ? <Check size={12} strokeWidth={3.2} /> : null}
      </span>
      <Tag size={17} aria-hidden="true" className="flex-none text-(--bd-primary-600)" />
      <span className="font-bold text-ink-900">{label}</span>
    </label>
  );
}

/**
 * The bar shown while the domain choice is unsaved. At least one domain must
 * stay ticked; removing a saved domain asks for confirmation first.
 */
function SaveBar({
  empty,
  busy,
  note,
  confirmingRemoval,
  onCancelRemoval,
  onDiscard,
  onSave,
}: Readonly<{
  empty: boolean;
  busy: boolean;
  /** The bar's message. */
  note: string;
  /** A removal is waiting for confirmation. */
  confirmingRemoval: boolean;
  onCancelRemoval: () => void;
  onDiscard: () => void;
  onSave: () => void;
}>) {
  const t = useTranslations('console');
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-[12px] border border-(--bd-border-soft) bg-(--bd-bg) px-3 py-2.5">
      <span
        id="coordinator-domains__error"
        className={cn('mr-auto text-[13px]', empty ? 'text-rose-700' : 'text-ink-500')}
      >
        {note}
      </span>
      {confirmingRemoval ? (
        <Button kind="ghost" disabled={busy} onClick={onCancelRemoval}>
          {t('coordinator.cancel')}
        </Button>
      ) : (
        <Button kind="ghost" disabled={busy} onClick={onDiscard}>
          {t('coordinator.discard')}
        </Button>
      )}
      <Button disabled={busy} onClick={onSave}>
        {confirmingRemoval
          ? t('coordinator.remove_domains_confirm')
          : t('coordinator.save_domains')}
      </Button>
    </div>
  );
}
