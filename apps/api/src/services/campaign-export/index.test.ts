import { describe, it, expect } from 'vitest';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '../mailer/interface.js';
import type { SignedDownloadUrl } from '../object-storage/index.js';
import { runExport, type ExportDeps } from './index.js';

function row(
  overrides: Partial<SignalStackDecryptedProfileRow> = {},
): SignalStackDecryptedProfileRow {
  return {
    item_id: 'item-1',
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: { name: 'Asha', phone: '+910000000000' },
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
}

function harness(over: Partial<ExportDeps> = {}): Harness {
  const puts: Harness['puts'] = [];
  const mails: SendInput[] = [];
  const logs = { info: [] as object[], warn: [] as object[], error: [] as object[] };
  const deps: ExportDeps = {
    fetchDecryptedProfiles: async () => ok({ profiles: [row()], skipped: [] }),
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
    networkAdminEmail: 'admin@network.org',
    log: {
      info: (o) => logs.info.push(o),
      warn: (o) => logs.warn.push(o),
      error: (o) => logs.error.push(o),
    },
    ...over,
  };
  return { deps, puts, mails, logs };
}

describe('runExport', () => {
  it('uploads a CSV and emails the network admin with exported/skipped counts', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () =>
        ok({ profiles: [row({ item_id: 'a' }), row({ item_id: 'b' })], skipped: ['c'] }),
    });

    await runExport({ orgId: 'org-1', itemIds: ['a', 'b', 'c'], purpose: 'audit' }, h.deps);

    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.key).toMatch(/^campaign-exports\/org-1\/.*\.csv$/);
    expect(h.puts[0]!.contentType).toBe('text/csv');
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0]!.to).toBe('admin@network.org');
    expect(h.mails[0]!.text).toContain('Records exported: 2');
    expect(h.mails[0]!.text).toContain('Skipped (not found / not owned): 1');
    expect(h.mails[0]!.text).toContain('org-1');
    expect(h.mails[0]!.text).toContain('audit');
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

  it('aborts (no upload, no email) when resolved items span more than one type/domain', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () =>
        ok({
          profiles: [row({ item_domain: 'seeker' }), row({ item_domain: 'provider' })],
          skipped: [],
        }),
    });
    await runExport({ orgId: 'org-1', itemIds: ['a', 'b'] }, h.deps);
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
    expect(h.logs.error).toHaveLength(1);
  });

  it('aborts when decrypt fails', async () => {
    const h = harness({
      fetchDecryptedProfiles: async () => err(new UpstreamError('signals down', { code: 'X' })),
    });
    await runExport({ orgId: 'org-1', itemIds: ['a'] }, h.deps);
    expect(h.puts).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
    expect(h.logs.error).toHaveLength(1);
  });

  it('logs a failure and does not throw when the email send fails', async () => {
    const h = harness({
      sendMail: async () => ({
        ok: false,
        error: { code: 'TRANSPORT_FAILED', message: 'smtp down' },
      }),
    });
    await expect(runExport({ orgId: 'org-1', itemIds: ['a'] }, h.deps)).resolves.toBeUndefined();
    expect(h.puts).toHaveLength(1); // upload still happened before the email
    expect(h.logs.error).toHaveLength(1);
  });

  it('never logs raw item_state / PII values', async () => {
    const h = harness();
    await runExport({ orgId: 'org-1', itemIds: ['a'] }, h.deps);
    const serialized = JSON.stringify([...h.logs.info, ...h.logs.warn, ...h.logs.error]);
    expect(serialized).not.toContain('Asha');
    expect(serialized).not.toContain('+910000000000');
  });
});
