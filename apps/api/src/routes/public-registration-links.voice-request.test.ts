/**
 * Tests for the voice-bot request on a two-option link (aggregator-dpg#1122).
 *
 *   POST /public/v1/aggregators/:org/voice-requests/:slug
 *
 * - A new phone creates the account (account-only onboard) and returns the bot.
 * - An existing phone (this coordinator's or another's) creates nothing and
 *   still returns the bot, never a 409.
 * - A failed probe answers 502 and writes nothing.
 * - Body, consent, minor and rate-limit rules match the account-only submit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { UserStoreFake, _setUserStore, buildCoordinator } from '../services/user-store/index.js';
import { _setSignalStackWriter } from '../services/signalstack.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { _setDbClients } from '../db/client.js';
import {
  _setRegistrationLinksStore,
  RegistrationLinksStoreBase,
  type RegistrationLink,
  type StoreResult,
} from '../services/registration-links-store/index.js';
import { _setSchemaLoader } from '../services/schema-loader/index.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import type { ResolvedNetworkConfig, VoiceBot } from '@aggregator-dpg/network-config/interface';
import { err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';

const { consumeMock } = vi.hoisted(() => ({
  consumeMock: vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 }),
}));
vi.mock('../services/rate-limiter/index.js', () => ({ consume: consumeMock }));

const AGG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = 'org-signalstack-1';
const ORG_SLUG = 'acme';
const LINK_ID = '22222222-2222-2222-2222-222222222222';
const SLUG = 'two-option';
const FORM_SLUG = 'form-only';
const SUBMISSION_ID = '44444444-4444-4444-4444-444444444444';

const BOT_A: VoiceBot = {
  key: 'a',
  display_name: 'Asha',
  phone: '+919811100001',
  languages: ['hi', 'en'],
  domains: ['seeker'],
  description: 'Helps job seekers',
};

/** Store serving the two-option link and a form-only link. */
class LinksStore extends RegistrationLinksStoreBase {
  constructor(private readonly links: Record<string, RegistrationLink>) {
    super();
  }
  async findByOrgAndSlug(
    orgSlug: string,
    slug: string,
  ): Promise<StoreResult<RegistrationLink | null>> {
    if (orgSlug !== ORG_SLUG) return { ok: true, value: null };
    return { ok: true, value: this.links[slug] ?? null };
  }
  async create(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
  async findById(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async findBySlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async updateDraft(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
  async list(): Promise<StoreResult<{ rows: RegistrationLink[]; total: number }>> {
    return { ok: true, value: { rows: [], total: 0 } };
  }
  async updateStatus(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
}

/** Outcome of every `link_submissions` row the fake DB stored, in order. */
interface StoredRow {
  outcome: unknown;
}

/** Fake DB whose transaction records each inserted row and outcome update. */
function buildFakeDb(rows: StoredRow[]): unknown {
  const insert = () => ({
    values(v: { outcome: unknown }) {
      const row: StoredRow = { outcome: v.outcome };
      rows.push(row);
      return {
        async returning() {
          return [{ id: SUBMISSION_ID }];
        },
      };
    },
  });
  const tx = {
    insert,
    update() {
      return {
        set: (s: { outcome: unknown }) => ({
          async where() {
            const last = rows.at(-1);
            if (last) last.outcome = s.outcome;
          },
        }),
      };
    },
  };
  return {
    insert,
    async transaction(cb: (t: unknown) => Promise<unknown>) {
      return cb(tx);
    },
  };
}

const baseLink = {
  userId: AGG_ID,
  domain: 'seeker' as const,
  context: {},
  qrObjectKey: null,
  status: 'live' as const,
  expiresAt: null,
  createdBy: 'system',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const LINKS: Record<string, RegistrationLink> = {
  [SLUG]: {
    ...baseLink,
    id: LINK_ID,
    slug: SLUG,
    registrationMode: 'voice_or_form',
    voiceBotKey: 'a',
  },
  [FORM_SLUG]: {
    ...baseLink,
    id: '33333333-3333-3333-3333-333333333333',
    slug: FORM_SLUG,
    registrationMode: 'form',
    voiceBotKey: null,
  },
};

/** Blue-dot config with a `voice_or_form` mode and the given bots. */
function configWith(
  voiceBots: VoiceBot[],
  opts: { consentRequired?: boolean } = {},
): ResolvedNetworkConfig {
  const base = buildBlueDotConfig();
  if (opts.consentRequired) {
    Object.values(base.domains).forEach((d) => {
      d.goLiveRequired = ['schema_required', 'consent_required'];
    });
  }
  return {
    ...base,
    aggregator: {
      ...base.aggregator,
      voice_bots: voiceBots,
      registration_modes: {
        ...base.aggregator.registration_modes,
        voice_or_form: {
          label_i18n_key: 'registration_mode.voice_or_form.label',
          submission_shape: 'account_and_profile',
          public_hint_i18n_key: null,
          signals_cta: true,
          offers: ['voice', 'form'],
        },
      },
    },
  };
}

interface Harness {
  app: FastifyInstance;
  writer: SignalStackWriterFake;
  rows: StoredRow[];
}

async function bootApp(cfg: ResolvedNetworkConfig): Promise<Harness> {
  consumeMock.mockClear();
  consumeMock.mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 });
  process.env.SIGNALSTACK_BASE_URL = 'http://stub-signalstack';
  process.env.SIGNALSTACK_ADMIN_KEY = 'stub-key';
  process.env.SIGNALSTACK_ACTING_ORG_ID = 'org_platform';
  process.env.SIGNALSTACK_ITEM_NETWORK = 'blue_dot';
  _setNetworkConfig(cfg);

  const aggStore = new UserStoreFake();
  aggStore.seed([
    buildCoordinator({
      id: AGG_ID,
      orgSlug: ORG_SLUG,
      name: 'Acme',
      status: 'active',
      signalstackOrgId: ORG_ID,
    }),
  ]);
  _setUserStore(aggStore);
  const writer = new SignalStackWriterFake();
  _setSignalStackWriter(writer);
  _setRegistrationLinksStore(new LinksStore(LINKS));
  const rows: StoredRow[] = [];
  _setDbClients(null, buildFakeDb(rows) as never);
  return { app: await buildApp(), writer, rows };
}

async function teardown(app: FastifyInstance | undefined): Promise<void> {
  await app?.close();
  _setSignalStackWriter(null);
  _setUserStore(null);
  _setRegistrationLinksStore(null);
  _setNetworkConfig(null);
  _setDbClients(null, null);
  _setSchemaLoader(null);
}

function request(app: FastifyInstance, payload: Record<string, unknown>, slug = SLUG) {
  return app.inject({
    method: 'POST',
    url: `/public/v1/aggregators/${ORG_SLUG}/voice-requests/${slug}`,
    payload,
  });
}

const ADULT = {
  name: 'A. User',
  phone: '+919876543210',
  consent_terms: true,
  consent_privacy: true,
};

describe('POST /public/v1/aggregators/:org/voice-requests/:slug', () => {
  let h: Harness;
  afterEach(() => teardown(h?.app));

  describe('with bot a on a two-option link', () => {
    beforeEach(async () => {
      h = await bootApp(configWith([BOT_A], { consentRequired: true }));
    });

    it('creates the account for a new phone and returns the bot', async () => {
      const onboard = vi.spyOn(h.writer, 'onboard');
      const r = await request(h.app, ADULT);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        existing: false,
        voice_bot: { display_name: 'Asha', phone: BOT_A.phone, languages: ['hi', 'en'] },
      });
      expect(onboard).toHaveBeenCalledTimes(1);
      expect(onboard.mock.calls[0]?.[0]).toMatchObject({
        submit_mode: 'account_only',
        channel: 'link',
        source_id: LINK_ID,
        actingOrgId: ORG_ID,
        phoneNumber: '+919876543210',
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
        ],
      });
      expect(h.rows).toEqual([{ outcome: 'passed' }]);
    });

    it('writes a PII-free audit line when the account is created', async () => {
      const info = vi.fn();
      const appChild = h.app.log.child.bind(h.app.log);
      const childSpy = vi.spyOn(h.app.log, 'child').mockImplementation(((
        ...args: Parameters<typeof appChild>
      ) => {
        const reqLog = appChild(...args);
        const reqChild = reqLog.child.bind(reqLog);
        reqLog.child = ((...childArgs: Parameters<typeof reqChild>) => {
          const routeLog = reqChild(...childArgs);
          const realInfo = routeLog.info.bind(routeLog);
          routeLog.info = ((...a: Parameters<typeof realInfo>) => {
            info(...a);
            return realInfo(...a);
          }) as never;
          return routeLog;
        }) as never;
        return reqLog;
      }) as never);
      const r = await request(h.app, ADULT);
      childSpy.mockRestore();
      expect(r.statusCode).toBe(200);
      const audit = info.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((o) => o?.event_type === 'audit');
      expect(audit).toMatchObject({
        audit: 'link.voice_request_recorded',
        link_id: LINK_ID,
        voice_bot_key: 'a',
        existing: false,
        outcome: 'passed',
      });
      expect(JSON.stringify(audit)).not.toContain('9876543210');
      expect(JSON.stringify(audit)).not.toContain('A. User');
    });

    it('creates nothing for a phone this coordinator already has', async () => {
      h.writer.seedOwnUser({ actingOrgId: ORG_ID, phoneNumber: '+919876543210' });
      const onboard = vi.spyOn(h.writer, 'onboard');
      const r = await request(h.app, ADULT);
      expect(r.statusCode).toBe(200);
      expect(r.json().existing).toBe(true);
      expect(onboard).not.toHaveBeenCalled();
      expect(h.rows).toEqual([{ outcome: 'skipped' }]);
    });

    it('answers 200, not 409, for a phone another aggregator owns', async () => {
      h.writer.seedForeignUser({ phoneNumber: '+919876543210' });
      const onboard = vi.spyOn(h.writer, 'onboard');
      const r = await request(h.app, ADULT);
      expect(r.statusCode).toBe(200);
      expect(r.json().existing).toBe(true);
      expect(onboard).not.toHaveBeenCalled();
      expect(h.rows).toEqual([{ outcome: 'skipped' }]);
    });

    it('normalises the phone before the probe', async () => {
      h.writer.seedOwnUser({ actingOrgId: ORG_ID, phoneNumber: '+919876543210' });
      const r = await request(h.app, { ...ADULT, phone: '098765 43210' });
      expect(r.statusCode).toBe(200);
      expect(r.json().existing).toBe(true);
    });

    it('finds an existing person stored with a landline-range number', async () => {
      h.writer.seedOwnUser({ actingOrgId: ORG_ID, phoneNumber: '+918020123456' });
      const onboard = vi.spyOn(h.writer, 'onboard');
      const r = await request(h.app, { ...ADULT, phone: '+918020123456' });
      expect(r.statusCode).toBe(200);
      expect(r.json().existing).toBe(true);
      expect(onboard).not.toHaveBeenCalled();
    });

    it('refuses a new landline-range number with 400 INVALID_PHONE and writes nothing', async () => {
      const onboard = vi.spyOn(h.writer, 'onboard');
      const r = await request(h.app, { ...ADULT, phone: '+918020123456' });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('INVALID_PHONE');
      expect(onboard).not.toHaveBeenCalled();
      expect(h.rows).toEqual([]);
    });

    it('answers 502 and writes nothing when the probe fails', async () => {
      vi.spyOn(h.writer, 'probeUser').mockResolvedValueOnce(
        err(new UpstreamError('signals down', { code: 'SIGNALSTACK_UNAVAILABLE' })),
      );
      const onboard = vi.spyOn(h.writer, 'onboard');
      const r = await request(h.app, ADULT);
      expect(r.statusCode).toBe(502);
      expect(r.json().error.code).toBe('SIGNALSTACK_PROBE_FAILED');
      expect(onboard).not.toHaveBeenCalled();
      expect(h.rows).toEqual([]);
    });

    it('rejects an email with 400 REGISTRATION_MODE_MISMATCH', async () => {
      const r = await request(h.app, { ...ADULT, email: 'u@example.com' });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('REGISTRATION_MODE_MISMATCH');
    });

    it('rejects a profile field with 400 REGISTRATION_MODE_MISMATCH', async () => {
      const r = await request(h.app, { ...ADULT, skills: ['welding'] });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('REGISTRATION_MODE_MISMATCH');
    });

    it('rejects a missing phone with 400 SCHEMA_VALIDATION', async () => {
      const { phone: _p, ...noPhone } = ADULT;
      const r = await request(h.app, noPhone);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
    });

    it('rejects an adult without consent with 400 CONSENT_REQUIRED', async () => {
      const r = await request(h.app, { name: 'A. User', phone: '+919876543210' });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('CONSENT_REQUIRED');
      expect(h.rows).toEqual([]);
    });

    it('sends neither consent nor age for a minor', async () => {
      const onboard = vi.spyOn(h.writer, 'onboard');
      const yearOfBirth = new Date().getUTCFullYear() - 15;
      const r = await request(h.app, {
        name: 'Minor User',
        phone: '+919876543210',
        year_of_birth: yearOfBirth,
      });
      expect(r.statusCode).toBe(200);
      const input = onboard.mock.calls[0]?.[0];
      expect(input).toBeDefined();
      expect(input).not.toHaveProperty('compliance');
      expect(input).not.toHaveProperty('age');
    });

    it('answers 409 VOICE_BOT_UNAVAILABLE on a form-only link', async () => {
      const r = await request(h.app, ADULT, FORM_SLUG);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('VOICE_BOT_UNAVAILABLE');
    });

    it('uses the shared submit rate limit and answers 429 when it trips', async () => {
      consumeMock.mockResolvedValueOnce({ allowed: false, count: 21, retryAfterSeconds: 7 });
      const r = await request(h.app, ADULT);
      expect(r.statusCode).toBe(429);
      expect(consumeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'link-submit',
          key: `${ORG_SLUG}:${SLUG}:127.0.0.1`,
        }),
      );
      expect(h.rows).toEqual([]);
    });
  });

  it('answers 409 VOICE_BOT_UNAVAILABLE when no bot is configured', async () => {
    h = await bootApp(configWith([]));
    const r = await request(h.app, ADULT);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('VOICE_BOT_UNAVAILABLE');
  });

  it('returns the phone currently in config for the bot', async () => {
    const newPhone = '+919811199999';
    h = await bootApp(configWith([{ ...BOT_A, phone: newPhone }]));
    const r = await request(h.app, ADULT);
    expect(r.statusCode).toBe(200);
    expect(r.json().voice_bot.phone).toBe(newPhone);
  });
});
