'use client';

/**
 * Coordinator actions: change the domains served while the coordinator is
 * pending; after that, and for a viewer who cannot manage the coordinator's
 * organisation, the domains are read-only.
 *
 * Domains are the network's configured domains. A coordinator saved with none
 * serves every domain, so all are shown ticked. A save bar appears once the
 * choice differs from what is saved, and at least one domain must stay ticked.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Tag } from 'lucide-react';
import type { User } from '@aggregator-dpg/shared-primitives/user-org';
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
  // An empty `serves` means every domain, shown as all of them ticked.
  const ticked = (serves: readonly string[]) =>
    serves.length ? [...serves] : domains.map((d) => d.id);
  const [saved, setSaved] = useState<string[]>(() => ticked(user.serves));
  const [chosen, setChosen] = useState<string[]>(() => ticked(user.serves));
  const [servesNote, setServesNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty = !sameIds(chosen, saved);
  const empty = chosen.length === 0;

  function toggle(id: string) {
    setServesNote(null);
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  }

  function discard() {
    setChosen(saved);
    setServesNote(null);
  }

  async function saveServes() {
    setBusy(true);
    const r = await sendConsole<User>(`/api/console/user/metadata/${user.id}`, 'PATCH', {
      serves: chosen,
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
            {readOnly || user.status !== 'pending' ? (
              <DomainChips domains={domains.filter((d) => saved.includes(d.id))} />
            ) : (
              <>
                <fieldset
                  aria-label={t('coordinator.domains')}
                  className="m-0 min-w-0 border-0 p-0 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5"
                >
                  {domains.map((d) => {
                    const on = chosen.includes(d.id);
                    return (
                      <label
                        key={d.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-[12px] border-[1.5px] border-(--bd-border) bg-(--bd-card) p-3.5 transition-colors hover:border-ink-400 focus-within:shadow-[0_0_0_3px_var(--bd-primary-50)]',
                          on &&
                            'border-(--bd-primary) bg-(--bd-primary-50) hover:border-(--bd-primary)',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={on}
                          onChange={() => toggle(d.id)}
                        />
                        <span
                          aria-hidden="true"
                          className={cn(
                            'grid h-5 w-5 flex-none place-items-center rounded-md border-[1.5px] border-(--bd-border) bg-(--bd-card) text-white',
                            on && 'border-(--bd-primary) bg-(--bd-primary)',
                          )}
                        >
                          {on ? <Check size={12} strokeWidth={3.2} /> : null}
                        </span>
                        <Tag
                          size={17}
                          aria-hidden="true"
                          className="flex-none text-(--bd-primary-600)"
                        />
                        <span className="font-bold text-ink-900">{d.label}</span>
                      </label>
                    );
                  })}
                </fieldset>

                {dirty ? (
                  <div className="flex flex-wrap items-center gap-2.5 rounded-[12px] border border-(--bd-border-soft) bg-(--bd-bg) px-3 py-2.5">
                    <span
                      className={cn(
                        'mr-auto text-[13px]',
                        empty ? 'text-rose-700' : 'text-ink-500',
                      )}
                    >
                      {empty ? t('coordinator.domains_empty') : t('coordinator.unsaved')}
                    </span>
                    <Button kind="ghost" disabled={busy} onClick={discard}>
                      {t('coordinator.discard')}
                    </Button>
                    <Button disabled={busy || empty} onClick={() => void saveServes()}>
                      {t('coordinator.save_domains')}
                    </Button>
                  </div>
                ) : null}
                {servesNote ? (
                  <output className="text-[13px] text-ink-600">{servesNote}</output>
                ) : null}
              </>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
