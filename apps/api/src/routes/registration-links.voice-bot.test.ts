/**
 * Tests for the voice-bot choice on POST /v1/links/create, the `voice_bot` /
 * `voice_bot_key` fields on link responses, PATCH rejecting `voice_bot_key`,
 * and the coordinator picker list GET /v1/links/voice-bots (#1122).
 *
 * Config: bots `a` and `b` serve seeker, `p` serves provider; mode
 * `voice_or_form` offers voice. Store and auth are stubbed as in
 * registration-links.registration-mode.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { UserStoreFake, _setUserStore, buildCoordinator } from '../services/user-store/index.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import type { ResolvedNetworkConfig, VoiceBot } from '@aggregator-dpg/network-config/interface';
import {
  _setRegistrationLinksStore,
  RegistrationLinksStoreBase,
  type RegistrationLink,
  type CreateRegistrationLinkInput,
  type StoreResult,
} from '../services/registration-links-store/index.js';
import { _setDbClients } from '../db/client.js';
import { _setObjectStorage } from '@aggregator-dpg/object-storage';

const AGG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = 'org-signalstack-1';
const ORG_SLUG = 'acme';
const USER_ID = 'kc-user-1';

/**
 * Tracking stub: records every create input and returns a synthetic row.
 * Status forced to 'draft' to keep the route off the QR/object-storage path.
 */
class TrackingRegistrationLinksStore extends RegistrationLinksStoreBase {
  readonly creates: CreateRegistrationLinkInput[] = [];
  /** Rows returned by `findById` (by id) and `list`. */
  readonly rows: RegistrationLink[] = [];
  private idCounter = 0;

  async create(input: CreateRegistrationLinkInput): Promise<StoreResult<RegistrationLink>> {
    this.creates.push(input);
    this.idCounter++;
    const now = new Date();
    const row: RegistrationLink = {
      id: `link-${this.idCounter}`,
      aggregatorId: input.aggregatorId,
      slug: input.slug,
      domain: input.domain,
      context: input.context,
      registrationMode: input.registrationMode ?? 'form',
      voiceBotKey: input.voiceBotKey ?? null,
      qrObjectKey: null,
      status: input.status ?? 'draft',
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    return { ok: true, value: row };
  }

  async findById(id: string): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: this.rows.find((r) => r.id === id) ?? null };
  }
  async findBySlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async findByOrgAndSlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async updateDraft(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
  async list(): Promise<StoreResult<{ rows: RegistrationLink[]; total: number }>> {
    return { ok: true, value: { rows: this.rows, total: this.rows.length } };
  }
  async updateStatus(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'stub' } };
  }
}

const AUTH_TOKEN = 'agg-a-token';

/**
 * Minimal db stub that satisfies fetchLinkMetrics' query chain by resolving
 * to an empty rowset. The route then falls back to ZERO_METRICS — exactly
 * what we want since this test file does not exercise the metrics path.
 */
function buildMetricsStubDb(): unknown {
  const emptyChain = {
    select: () => emptyChain,
    from: () => emptyChain,
    where: () => emptyChain,
    groupBy: () => Promise.resolve([] as unknown[]),
  };
  return emptyChain;
}

async function bootApp(
  cfg: ResolvedNetworkConfig = buildVoiceBotConfig(),
): Promise<{ app: FastifyInstance; store: TrackingRegistrationLinksStore }> {
  _resetJwks();
  process.env.KEYCLOAK_URL = 'http://kc.local';
  process.env.KEYCLOAK_REALM = 'bluedots';
  _setNetworkConfig(cfg);
  _setAccessTokenVerifier(async (token) => {
    if (token !== AUTH_TOKEN) throw new Error('invalid');
    return {
      sub: USER_ID,
      email: 'a@x.com',
      aggregator_id: AGG_ID,
      aggregator_type: 'seeker',
      decision_made: 'approved',
    };
  });
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
  const store = new TrackingRegistrationLinksStore();
  _setRegistrationLinksStore(store);
  _setDbClients(null, buildMetricsStubDb() as never);
  const app = await buildApp();
  return { app, store };
}

const BOT_A: VoiceBot = {
  key: 'a',
  display_name: 'Bot A',
  phone: '+919000000001',
  languages: ['en', 'hi'],
  domains: ['seeker'],
  description: 'First seeker bot',
};
const BOT_B: VoiceBot = { ...BOT_A, key: 'b', display_name: 'Bot B', phone: '+919000000002' };
const BOT_P: VoiceBot = {
  key: 'p',
  display_name: 'Bot P',
  phone: '+919000000003',
  languages: ['en'],
  domains: ['provider'],
};

/** blue_dot config with a `voice_or_form` mode and the given bots / defaults. */
function buildVoiceBotConfig(
  voiceBots: VoiceBot[] = [BOT_A, BOT_B, BOT_P],
  defaults?: Record<string, string>,
): ResolvedNetworkConfig {
  const base = buildBlueDotConfig();
  return {
    ...base,
    aggregator: {
      ...base.aggregator,
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
      voice_bots: voiceBots,
      ...(defaults ? { default_voice_bots: defaults } : {}),
    },
  };
}

let app: FastifyInstance;
let store: TrackingRegistrationLinksStore;

async function boot(cfg?: ResolvedNetworkConfig): Promise<void> {
  ({ app, store } = await bootApp(cfg));
}

afterEach(async () => {
  await app?.close();
  _setAccessTokenVerifier(null);
  _setUserStore(null);
  _setRegistrationLinksStore(null);
  _setNetworkConfig(null);
  _setDbClients(null, null);
});

const create = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/links/create',
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    payload,
  });

describe('POST /v1/links/create — voice_bot_key', () => {
  it('rejects a key on a mode that does not offer voice', async () => {
    await boot();
    const r = await create({ domain: 'seeker', registration_mode: 'form', voice_bot_key: 'a' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
    expect(r.json().error.fields.voice_bot_key).toBeDefined();
    expect(store.creates).toHaveLength(0);
  });

  it('stores null for a form link with no key', async () => {
    await boot();
    const r = await create({ domain: 'seeker', registration_mode: 'form' });
    expect(r.statusCode).toBe(201);
    expect(store.creates[0]!.voiceBotKey).toBeNull();
    expect(r.json().voice_bot_key).toBeNull();
    expect(r.json().voice_bot).toBeNull();
  });

  it('stores a configured key and returns the bot without domains', async () => {
    await boot();
    const r = await create({
      domain: 'seeker',
      registration_mode: 'voice_or_form',
      voice_bot_key: 'a',
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(store.creates[0]!.voiceBotKey).toBe('a');
    expect(body.voice_bot_key).toBe('a');
    expect(body.voice_bot.phone).toBe(BOT_A.phone);
    expect(body.voice_bot.display_name).toBe('Bot A');
    expect(body.voice_bot.domains).toBeUndefined();
  });

  it('rejects an unknown key with INVALID_VOICE_BOT listing the configured keys', async () => {
    await boot();
    const r = await create({
      domain: 'seeker',
      registration_mode: 'voice_or_form',
      voice_bot_key: 'zzz',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_VOICE_BOT');
    expect(r.json().error.fields.configured).toEqual(['a', 'b']);
    expect(store.creates).toHaveLength(0);
  });

  it('rejects a key that serves another domain', async () => {
    await boot();
    const r = await create({
      domain: 'seeker',
      registration_mode: 'voice_or_form',
      voice_bot_key: 'p',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_VOICE_BOT');
  });

  it('stores the default bot key when no key is sent', async () => {
    await boot(buildVoiceBotConfig(undefined, { seeker: 'a' }));
    const r = await create({ domain: 'seeker', registration_mode: 'voice_or_form' });
    expect(r.statusCode).toBe(201);
    expect(store.creates[0]!.voiceBotKey).toBe('a');
    expect(r.json().voice_bot_key).toBe('a');
    expect(r.json().voice_bot.key).toBe('a');
  });

  it('stores the only bot key when one bot serves the domain', async () => {
    await boot(buildVoiceBotConfig([BOT_A, BOT_P]));
    const r = await create({ domain: 'seeker', registration_mode: 'voice_or_form' });
    expect(r.statusCode).toBe(201);
    expect(store.creates[0]!.voiceBotKey).toBe('a');
    expect(r.json().voice_bot_key).toBe('a');
  });

  it('keeps the link on its bot when a second bot is added later as the default', async () => {
    await boot(buildVoiceBotConfig([BOT_A]));
    const r = await create({ domain: 'seeker', registration_mode: 'voice_or_form' });
    expect(r.statusCode).toBe(201);
    const created = store.creates[0]!;
    expect(created.voiceBotKey).toBe('a');
    store.rows.push({
      id: r.json().link_id,
      aggregatorId: created.aggregatorId,
      slug: created.slug,
      domain: created.domain,
      context: created.context,
      registrationMode: 'voice_or_form',
      voiceBotKey: created.voiceBotKey ?? null,
      qrObjectKey: null,
      status: 'draft',
      expiresAt: null,
      createdBy: created.createdBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    _setNetworkConfig(buildVoiceBotConfig([BOT_A, BOT_B], { seeker: 'b' }));
    const read = await app.inject({
      method: 'GET',
      url: `/v1/links/${r.json().link_id}`,
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().voice_bot.key).toBe('a');
    expect(read.json().voice_bot.phone).toBe(BOT_A.phone);
  });

  it('requires a key when several bots serve the domain and none is the default', async () => {
    await boot();
    const r = await create({ domain: 'seeker', registration_mode: 'voice_or_form' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VOICE_BOT_REQUIRED');
  });

  it('creates with voice_bot null when no bots are configured', async () => {
    await boot(buildVoiceBotConfig([]));
    const r = await create({ domain: 'seeker', registration_mode: 'voice_or_form' });
    expect(r.statusCode).toBe(201);
    expect(store.creates[0]!.voiceBotKey).toBeNull();
    expect(r.json().voice_bot).toBeNull();
  });
});

describe('voice_bot on read for modes that do not offer voice', () => {
  const rowFor = (id: string, registrationMode: string, voiceBotKey: string | null) => {
    const now = new Date();
    const row: RegistrationLink = {
      id,
      aggregatorId: AGG_ID,
      slug: `slug-${id}`,
      domain: 'seeker',
      context: {},
      registrationMode,
      voiceBotKey,
      qrObjectKey: null,
      status: 'draft',
      expiresAt: null,
      createdBy: USER_ID,
      createdAt: now,
      updatedAt: now,
    };
    return row;
  };
  const get = (id: string) =>
    app.inject({
      method: 'GET',
      url: `/v1/links/${id}`,
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
  const listAll = () =>
    app.inject({
      method: 'GET',
      url: '/v1/links',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });

  it('returns voice_bot null for a form link even with a single seeker bot', async () => {
    await boot(buildVoiceBotConfig([BOT_A]));
    const created = await create({ domain: 'seeker', registration_mode: 'form' });
    expect(created.json().voice_bot).toBeNull();
    store.rows.push(rowFor('f1', 'form', null), rowFor('v1', 'voice_or_form', null));
    const one = await get('f1');
    expect(one.statusCode).toBe(200);
    expect(one.json().voice_bot).toBeNull();
    const all = (await listAll()).json();
    const byId = new Map<string, { voice_bot: { key: string } | null }>(
      all.items.map((i: { link_id: string; voice_bot: { key: string } | null }) => [i.link_id, i]),
    );
    expect(byId.get('f1')?.voice_bot).toBeNull();
    expect(byId.get('v1')?.voice_bot?.key).toBe('a');
  });

  it('returns the bot for a voice_or_form link from GET', async () => {
    await boot(buildVoiceBotConfig([BOT_A]));
    store.rows.push(rowFor('v1', 'voice_or_form', null));
    const one = await get('v1');
    expect(one.json().voice_bot.key).toBe('a');
  });
});

describe('PATCH /v1/links/:id — voice_bot_key', () => {
  it('rejects voice_bot_key as an unknown key', async () => {
    await boot();
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/link-1',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { voice_bot_key: 'a' },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('GET /v1/links/voice-bots', () => {
  const list = (query: string) =>
    app.inject({
      method: 'GET',
      url: `/v1/links/voice-bots${query}`,
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });

  it('lists the bots serving the domain, without domains, plus the default key', async () => {
    await boot(buildVoiceBotConfig(undefined, { seeker: 'b' }));
    const r = await list('?domain=seeker');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.voice_bots.map((b: { key: string }) => b.key)).toEqual(['a', 'b']);
    expect(body.voice_bots[0].domains).toBeUndefined();
    expect(body.voice_bots[0].phone).toBe(BOT_A.phone);
    expect(body.default_voice_bot_key).toBe('b');
  });

  it('returns a null default when several bots serve the domain and none is the default', async () => {
    await boot();
    const r = await list('?domain=seeker');
    expect(r.json().default_voice_bot_key).toBeNull();
  });

  it('rejects an unknown domain with 400', async () => {
    await boot();
    const r = await list('?domain=nope');
    expect(r.statusCode).toBe(400);
  });
});
