/**
 * State for the invite form's address list: the chips, the text in the box,
 * how many addresses the cap left out, and the name of a chip moved back into
 * the box for correction.
 *
 * @module apps/web/src/components/console/invite/useRecipientList
 */

import { useState } from 'react';
import { appendCapped, type Recipient } from './invite-recipients';

/**
 * Holds the address list and the text box for the invite form.
 *
 * @param maxRecipients - The per-send cap.
 */
export function useRecipientList(maxRecipients: number) {
  const [draft, setDraft] = useState('');
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [skipped, setSkipped] = useState(0);
  // The name of a chip moved back into the box, given back when it is added again.
  const [heldName, setHeldName] = useState('');

  /** Replaces the list and records how many addresses the cap left out. */
  function update(list: Recipient[], skippedNow = 0) {
    setRecipients(list);
    setSkipped(skippedNow);
  }

  /** Gives the held name to the first address added from the box, then drops it. */
  function withHeldName(list: Recipient[]): Recipient[] {
    if (!heldName || list.length <= recipients.length) return list;
    setHeldName('');
    const i = recipients.length;
    return list.map((r, j) => (j === i ? { ...r, name: heldName } : r));
  }

  /** Adds the addresses in `text`, up to the cap, and empties the box. */
  function add(text: string) {
    const next = appendCapped(text, recipients, maxRecipients);
    update(withHeldName(next.list), next.skipped);
    setDraft('');
  }

  function remove(email: string) {
    update(recipients.filter((r) => r.email !== email));
  }

  /** Moves a chip back into the text box so it can be corrected; its name is kept. */
  function edit(email: string) {
    setHeldName(recipients.find((r) => r.email === email)?.name ?? '');
    remove(email);
    setDraft(email);
  }

  function setName(email: string, name: string) {
    setRecipients(recipients.map((r) => (r.email === email ? { ...r, name } : r)));
  }

  /** Sets the text in the box; an empty box drops the held name. */
  function changeDraft(value: string) {
    setDraft(value);
    if (!value) setHeldName('');
  }

  /**
   * Empties the box and returns the list to send. Text still in the box
   * counts, as if the user had pressed Enter. The list itself is not updated.
   */
  function collectForSend(): { all: Recipient[]; skipped: number } {
    const next = draft.trim()
      ? appendCapped(draft, recipients, maxRecipients)
      : { list: recipients, skipped: 0 };
    setDraft('');
    return { all: withHeldName(next.list), skipped: next.skipped };
  }

  return {
    draft,
    recipients,
    skipped,
    update,
    add,
    remove,
    edit,
    setName,
    changeDraft,
    collectForSend,
  };
}
