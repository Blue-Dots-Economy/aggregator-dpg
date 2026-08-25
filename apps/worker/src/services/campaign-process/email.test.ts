/**
 * Unit tests for the campaign email send loop — the per-recipient half of the
 * email channel, isolated from the job engine.
 *
 * @module @aggregator-dpg/worker
 */
import { describe, it, expect } from 'vitest';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import { sendCampaignEmails, type EmailSendDeps } from './email.js';

function row(
  itemId: string,
  contact: SignalStackDecryptedProfileRow['contact'] = {
    name: { value: 'Asha', source: 'item' },
    email: { value: `${itemId}@example.com`, source: 'user' },
  },
): SignalStackDecryptedProfileRow {
  return {
    item_id: itemId,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: {},
    ...(contact ? { contact } : {}),
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
}

const TEMPLATE = { subject: 'Hi {{first_name}}', bodyMarkdown: 'Hello {{name}}' };

interface Harness {
  deps: EmailSendDeps;
  sends: SendInput[];
  marks: Array<{ itemId: string; status: string; reason?: string; ref?: string }>;
  maxInFlight: () => number;
}

function harness(over: Partial<Pick<EmailSendDeps, 'sendMail' | 'concurrency'>> = {}): Harness {
  const sends: SendInput[] = [];
  const marks: Harness['marks'] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const deps: EmailSendDeps = {
    sendMail: async (input): Promise<MailerResult<SendOk>> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield so concurrent senders overlap observably.
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      sends.push(input);
      return { ok: true, value: { messageId: `msg-${sends.length}` } };
    },
    concurrency: 5,
    markRecipient: async (itemId, status, detail) => {
      marks.push({
        itemId,
        status,
        ...(detail?.reason ? { reason: detail.reason } : {}),
        ...(detail?.providerRef ? { ref: detail.providerRef } : {}),
      });
    },
    log: { info: () => undefined },
    ...over,
  };
  return { deps, sends, marks, maxInFlight: () => maxInFlight };
}

describe('sendCampaignEmails', () => {
  it('renders per recipient and reports sent with the mailer message id', async () => {
    const h = harness();
    const summary = await sendCampaignEmails([row('a')], TEMPLATE, h.deps);

    expect(summary).toEqual({ sent: 1, skippedNoContact: 0, failed: 0 });
    expect(h.sends[0]!.to).toBe('a@example.com');
    expect(h.sends[0]!.subject).toBe('Hi Asha');
    expect(h.marks).toEqual([{ itemId: 'a', status: 'sent', ref: 'msg-1' }]);
  });

  it('sets Reply-To only when the template carries one', async () => {
    const withReply = harness();
    await sendCampaignEmails([row('a')], { ...TEMPLATE, replyTo: 'x@y.example' }, withReply.deps);
    expect(withReply.sends[0]!.replyTo).toBe('x@y.example');

    const without = harness();
    await sendCampaignEmails([row('a')], TEMPLATE, without.deps);
    expect(without.sends[0]!.replyTo).toBeUndefined();
  });

  it('reports a recipient with no email as skipped_no_contact and sends nothing', async () => {
    const h = harness();
    const summary = await sendCampaignEmails(
      [row('a', { name: { value: 'Ravi', source: 'item' } })],
      TEMPLATE,
      h.deps,
    );
    expect(summary).toEqual({ sent: 0, skippedNoContact: 1, failed: 0 });
    expect(h.sends).toHaveLength(0);
    expect(h.marks).toEqual([
      { itemId: 'a', status: 'skipped_no_contact', reason: 'no_email_address' },
    ]);
  });

  it('records a send failure and keeps going through the rest of the batch', async () => {
    let call = 0;
    const h = harness({
      sendMail: async (): Promise<MailerResult<SendOk>> => {
        call += 1;
        return call === 1
          ? { ok: false, error: { code: 'TRANSPORT_FAILED', message: 'smtp refused' } }
          : { ok: true, value: { messageId: 'msg-ok' } };
      },
    });
    const summary = await sendCampaignEmails([row('a'), row('b')], TEMPLATE, h.deps);

    expect(summary).toEqual({ sent: 1, skippedNoContact: 0, failed: 1 });
    expect(h.marks).toContainEqual({
      itemId: 'a',
      status: 'failed',
      reason: 'TRANSPORT_FAILED: smtp refused',
    });
    expect(h.marks).toContainEqual({ itemId: 'b', status: 'sent', ref: 'msg-ok' });
  });

  it('never exceeds the configured send concurrency', async () => {
    const h = harness({ concurrency: 2 });
    const rows = Array.from({ length: 8 }, (_, i) => row(`r${i}`));
    const summary = await sendCampaignEmails(rows, TEMPLATE, h.deps);

    expect(summary.sent).toBe(8);
    expect(h.maxInFlight()).toBeLessThanOrEqual(2);
  });

  it('is a no-op for an empty recipient list', async () => {
    const h = harness();
    expect(await sendCampaignEmails([], TEMPLATE, h.deps)).toEqual({
      sent: 0,
      skippedNoContact: 0,
      failed: 0,
    });
    expect(h.sends).toHaveLength(0);
  });
});
