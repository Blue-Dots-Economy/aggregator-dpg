/**
 * The chip box on the invite form: one chip per address and the text box
 * that turns typed or pasted text into chips.
 */

import type { ClipboardEvent, KeyboardEvent, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { COMMIT_KEYS, type Recipient } from './invite-recipients';

/** Renders a `<kbd>` chunk in rich message text. */
function renderKbd(chunks: ReactNode) {
  return (
    <kbd className="whitespace-nowrap rounded-[5px] border border-b-2 border-(--bd-border) bg-(--bd-card) px-1.5 font-mono text-[11px] text-ink-700">
      {chunks}
    </kbd>
  );
}

/** The address chips, the text box and its hint. */
export function RecipientBox({
  recipients,
  draft,
  full,
  placeholder,
  onDraft,
  onAdd,
  onRemove,
  onEdit,
}: Readonly<{
  recipients: readonly Recipient[];
  draft: string;
  /** True when the list is at the per-send cap; the box is disabled. */
  full: boolean;
  placeholder: string;
  onDraft: (value: string) => void;
  /** Adds the addresses in the text. */
  onAdd: (text: string) => void;
  onRemove: (email: string) => void;
  /** Moves a chip back into the box so it can be corrected. */
  onEdit: (email: string) => void;
}>) {
  const t = useTranslations('console');

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const last = recipients.at(-1);
    if (COMMIT_KEYS.has(e.key) && draft.trim()) {
      e.preventDefault();
      onAdd(draft);
    } else if (e.key === 'Backspace' && !draft && last) {
      e.preventDefault();
      onEdit(last.email);
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    onAdd(draft + ' ' + e.clipboardData.getData('text'));
  }

  return (
    <>
      <div className="flex max-h-[180px] min-h-24 flex-wrap content-start items-center gap-2 overflow-auto rounded-[12px] border-[1.5px] border-(--bd-border) bg-(--bd-bg) p-3 transition-[border-color,box-shadow] focus-within:border-(--bd-primary) focus-within:bg-(--bd-card) focus-within:shadow-[0_0_0_4px_var(--bd-primary-50)]">
        {recipients.map((r) => (
          <span
            key={r.email}
            title={r.valid ? undefined : t('invite.reason.invalid_email')}
            onDoubleClick={() => onEdit(r.email)}
            className={cn(
              'inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg border pl-2.5 pr-1.5 text-[13.5px] font-medium',
              r.valid
                ? 'border-(--bd-primary-100) bg-(--bd-primary-50) text-(--bd-primary-600)'
                : 'border-rose-200 bg-rose-50 text-rose-700',
            )}
          >
            <span className="truncate">{r.email}</span>
            <button
              type="button"
              onClick={() => onRemove(r.email)}
              className="grid h-[22px] w-[22px] place-items-center rounded-md opacity-70 hover:bg-black/5 hover:opacity-100"
              aria-label={t('invite.remove', { email: r.email })}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          id="invite-emails"
          type="text"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={draft}
          disabled={full}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => draft.trim() && onAdd(draft)}
          placeholder={placeholder}
          aria-describedby="invite-emails-hint"
          className="h-8 min-w-[12rem] flex-1 bg-transparent px-1 text-[15px] text-ink-900 outline-none placeholder:text-ink-400"
        />
      </div>

      <span id="invite-emails-hint" className="text-[12.5px] text-ink-500">
        {t.rich('invite.recipients_hint', { kbd: renderKbd })}
      </span>
    </>
  );
}
