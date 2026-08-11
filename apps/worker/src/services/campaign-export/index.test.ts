import { describe, it, expect } from 'vitest';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import type { SignedDownloadUrl } from '../../object-storage.js';
import { runExport, type ExportDeps } from './index.js';

function row(
  overrides: Partial<SignalStackDecryptedProfileRow> = {},
): SignalStackDecryptedProfileRow {
  return {
    item_id: 'item-1',
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: {},
    contact: {
      name: { value: 'Asha', source: 'item' },
      email: { value: 'asha@example.com', source: 'user' },
      phone: { value: '+910000000000', source: 'item' },
    },
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

interface Harness {
  deps: ExportDeps;
  puts: Array<{ key: string; body: Buffer; contentType: string }>;
  mails: SendInput[];
  logs: { info: object[]; warn: object[]; error: object[] };
  decryptQueries: unknown[];
}

function harness(over: Partial<ExportDeps> = {}): Harness {
  const puts: Harness['puts'] = [];
  const mails: SendInput[] = [];
  const decryptQueries: unknown[] = [];
  const logs = { info: [] as object[], warn: [] as object[], error: [] as object[] };
  const deps: ExportDeps = {
    fetchDecryptedProfiles: async (q) => {
      decryptQueries.push(q);
      return ok({ profiles: [row()], skipped: [] });
    },
    putObject: async (key, body, contentType) => {
      puts.push({ key, body, contentType });
    },
    signDownloadUrl: async (key): Promise<SignedDownloadUrl> => ({
      url: `https://signed.example/${key}`,
      key,
      expiresAt: '2026-08-01T01:00:00.000Z',
    }),
    sendMail: async (input): Promise<MailerResult<SendOk>> => {
      mails.push(input);
      return { ok: true, value: { messageId: 'm-1' } };
    },
    recipientEmail: 'aggregator@org.example',
    log: {
      info: (o) => logs.info.push(o),
      warn: (o) => logs.warn.push(o),
      error: (o) => logs.error.push(o),
    },
    ...over,
  };
  return { deps, puts, mails, logs, decryptQueries };
}

describe('runExport', () => {
  it('requests a contact-only decrypt (fields:[] + contact name/email/phone)', async () => {
    const h = harness();
    await runExport({ orgId: 'org-1', itemIds: ['a'] }, h.deps);
    expect(h.decryptQueries[0]).toMatchObject({
      actingOrgId: 'org-1',
      itemIds: ['a'],
      fields: [],
      contact: ['name', 'email', 'phone'],
    });
  });

  it('uploads a contact CSV (name/email/phone + provenance) and emails the requesting aggregator', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () =>
        ok({ profiles: [row({ item_id: 'a' }), row({ item_id: 'b' })], skipped: ['c'] }),
    });

    await runExport({ orgId: 'org-1', itemIds: ['a', 'b', 'c'], purpose: 'audit' }, h.deps);

    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.key).toMatch(/^campaign-exports\/org-1\/.*\.csv$/);
    expect(h.puts[0]!.contentType).toBe('text/csv');
    const csv = h.puts[0]!.body.toString('utf8');
    expect(csv.split('\r\n')[0]).toBe(
      'item_id,name,name_source,email,email_source,phone,phone_source',
    );
    expect(csv).toContain('a,Asha,profile,asha@example.com,user,');
    // provenance labels present
    expect(csv).toMatch(/,profile,/);
    expect(csv).toMatch(/,user,/);

    expect(h.mails).toHaveLength(1);
    expect(h.mails[0]!.to).toBe('aggregator@org.example');
    expect(h.mails[0]!.text).toContain('Records exported: 2');
    expect(h.mails[0]!.text).toContain('Skipped (not found / not owned): 1');
    expect(h.mails[0]!.text).toContain('https://signed.example/');
  });

  it('does nothing (no upload, no email) when no items resolve', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () => ok({ profiles: [], skipped: ['x', 'y'] }),
    });
    await runExport({ orgId: 'org-1', itemIds: ['x', 'y'] }, h.deps);
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
    expect(h.logs.warn).toHaveLength(1);
  });

  it('exports mixed item types/domains without aborting (fixed 3-field schema)', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () =>
        ok({
          profiles: [
            row({ item_id: 'a', item_domain: 'seeker' }),
            row({ item_id: 'b', item_domain: 'provider' }),
          ],
          skipped: [],
        }),
    });
    await runExport({ orgId: 'org-1', itemIds: ['a', 'b'] }, h.deps);
    expect(h.puts).toHaveLength(1);
    expect(h.mails).toHaveLength(1);
    expect(h.logs.error).toHaveLength(0);
  });

  it('throws (so BullMQ retries) when decrypt fails, without uploading or emailing', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () => err(new UpstreamError('signals down', { code: 'X' })),
    });
    await expect(runExport({ orgId: 'org-1', itemIds: ['a'] }, h.deps)).rejects.toThrow(/decrypt/);
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
    expect(h.logs.error).toHaveLength(1);
  });

  it('throws when the decrypt returns no contact block (Signals predates #521)', async () => {
    const h = harness({
      // Row with no `contact` key — what an older Signals returns after silently
      // stripping the contact/fields projection. Must NOT be emailed as empty.
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
    await expect(runExport({ orgId: 'org-1', itemIds: ['a'] }, h.deps)).rejects.toThrow(/#521/);
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
    expect(h.logs.error).toHaveLength(1);
  });

  it('throws (so BullMQ retries) when the email send fails, after uploading', async () => {
    const h = harness({
      sendMail: async () => ({
        ok: false,
        error: { code: 'TRANSPORT_FAILED', message: 'smtp down' },
      }),
    });
    await expect(runExport({ orgId: 'org-1', itemIds: ['a'] }, h.deps)).rejects.toThrow(/email/);
    expect(h.puts).toHaveLength(1); // upload still happened before the email
    expect(h.logs.error).toHaveLength(1);
  });

  it('never logs raw contact PII values', async () => {
    const h = harness();
    await runExport({ orgId: 'org-1', itemIds: ['a'] }, h.deps);
    const serialized = JSON.stringify([...h.logs.info, ...h.logs.warn, ...h.logs.error]);
    expect(serialized).not.toContain('Asha');
    expect(serialized).not.toContain('+910000000000');
    expect(serialized).not.toContain('asha@example.com');
  });
});
