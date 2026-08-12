import { describe, it, expect } from 'vitest';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import { runEmailSend, type EmailDeps } from './index.js';

function row(over: Partial<SignalStackDecryptedProfileRow> = {}): SignalStackDecryptedProfileRow {
  return {
    item_id: 'item-1',
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: {},
    contact: {
      name: { value: 'Asha Rao', source: 'item' },
      email: { value: 'asha@example.com', source: 'item' },
      phone: { value: '+910000000000', source: 'user' },
    },
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

interface Harness {
  deps: EmailDeps;
  mails: SendInput[];
  queries: unknown[];
  logs: { info: object[]; warn: object[]; error: object[] };
}

function harness(over: Partial<EmailDeps> = {}): Harness {
  const mails: SendInput[] = [];
  const queries: unknown[] = [];
  const logs = { info: [] as object[], warn: [] as object[], error: [] as object[] };
  const deps: EmailDeps = {
    fetchDecryptedProfiles: async (q) => {
      queries.push(q);
      return ok({ profiles: [row()], skipped: [] });
    },
    sendMail: async (input): Promise<MailerResult<SendOk>> => {
      mails.push(input);
      return { ok: true, value: { messageId: 'm-1' } };
    },
    concurrency: 5,
    log: {
      info: (o) => logs.info.push(o),
      warn: (o) => logs.warn.push(o),
      error: (o) => logs.error.push(o),
    },
    ...over,
  };
  return { deps, mails, queries, logs };
}

const PARAMS = { orgId: 'org-1', itemIds: ['a'], subject: 'Hello', bodyMarkdown: 'Plain body.' };

describe('runEmailSend', () => {
  it('decrypts only the email field when the template has no placeholders', async () => {
    const h = harness();
    await runEmailSend(PARAMS, h.deps);
    expect(h.queries[0]).toMatchObject({ actingOrgId: 'org-1', fields: [], contact: ['email'] });
  });

  it('decrypts name + email when the template references a name placeholder', async () => {
    const h = harness();
    await runEmailSend({ ...PARAMS, subject: 'Hi {{first_name}}' }, h.deps);
    const q = h.queries[0] as { contact: string[] };
    expect(q.contact.sort()).toEqual(['email', 'name']);
  });

  it('renders per recipient and sends (subject + body substituted)', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () => ok({ profiles: [row({ item_id: 'a' })], skipped: [] }),
    });
    await runEmailSend(
      { ...PARAMS, subject: 'Hi {{first_name}}', bodyMarkdown: 'Dear {{name}}, **hello**' },
      h.deps,
    );
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0]!.to).toBe('asha@example.com');
    expect(h.mails[0]!.subject).toBe('Hi Asha');
    expect(h.mails[0]!.html).toContain('Dear Asha Rao');
    expect(h.mails[0]!.html).toContain('<strong>hello</strong>');
    expect(h.mails[0]!.text).toContain('Dear Asha Rao');
  });

  it('skips a recipient with no email but still sends to the rest', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () =>
        ok({
          profiles: [
            row({ item_id: 'a' }),
            row({ item_id: 'b', contact: { email: { value: null, source: null } } }),
          ],
          skipped: [],
        }),
    });
    await runEmailSend(PARAMS, h.deps);
    expect(h.mails).toHaveLength(1);
    const summary = h.logs.info.at(-1) as Record<string, unknown>;
    expect(summary).toMatchObject({ sent: 1, skipped_no_email: 1, failed: 0 });
  });

  it('counts a per-recipient send failure without failing the job (send-once)', async () => {
    const h = harness({
      sendMail: async () => ({ ok: false, error: { code: 'TRANSPORT_FAILED', message: 'down' } }),
    });
    await expect(runEmailSend(PARAMS, h.deps)).resolves.toBeUndefined();
    const summary = h.logs.info.at(-1) as Record<string, unknown>;
    expect(summary).toMatchObject({ sent: 0, failed: 1, status: 'partial' });
  });

  it('reports skipped_not_owned from the decrypt skipped[] list', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () => ok({ profiles: [row()], skipped: ['x', 'y'] }),
    });
    await runEmailSend({ ...PARAMS, itemIds: ['item-1', 'x', 'y'] }, h.deps);
    const summary = h.logs.info.at(-1) as Record<string, unknown>;
    expect(summary).toMatchObject({ sent: 1, skipped_not_owned: 2 });
  });

  it('throws (job fails) when decrypt fails, without sending', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () => err(new UpstreamError('signals down', { code: 'X' })),
    });
    await expect(runEmailSend(PARAMS, h.deps)).rejects.toThrow(/decrypt/);
    expect(h.mails).toHaveLength(0);
    expect(h.logs.error).toHaveLength(1);
  });

  it('throws when the decrypt returns no contact block (Signals predates #521)', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () =>
        ok({
          profiles: [
            {
              item_id: 'a',
              item_network: 'blue_dot',
              item_domain: 'seeker',
              item_type: 'profile_1.0',
              item_state: {},
              created_at: '2026-08-01T00:00:00.000Z',
              updated_at: '2026-08-01T00:00:00.000Z',
            },
          ],
          skipped: [],
        }),
    });
    await expect(runEmailSend(PARAMS, h.deps)).rejects.toThrow(/#521/);
    expect(h.mails).toHaveLength(0);
  });

  it('does nothing (no send) when no items resolve', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () => ok({ profiles: [], skipped: ['x'] }),
    });
    await runEmailSend(PARAMS, h.deps);
    expect(h.mails).toHaveLength(0);
    expect(h.logs.warn).toHaveLength(1);
  });

  it('forwards reply_to and never logs raw PII', async () => {
    const h = harness();
    await runEmailSend({ ...PARAMS, replyTo: 'campaign@org.example' }, h.deps);
    expect(h.mails[0]!.replyTo).toBe('campaign@org.example');
    const serialized = JSON.stringify([...h.logs.info, ...h.logs.warn, ...h.logs.error]);
    expect(serialized).not.toContain('Asha');
    expect(serialized).not.toContain('asha@example.com');
    expect(serialized).not.toContain('+910000000000');
  });
});
