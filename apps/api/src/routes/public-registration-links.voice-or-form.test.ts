/**
 * Tests for the `offers` and `voice_bot` keys on the public resolve endpoint
 * (aggregator-dpg#1122, two-option QR form).
 *
 *   GET /public/v1/aggregators/:org/links/:slug
 *
 * - `offers` comes from the link's registration mode; `voice` is dropped when
 *   no bot resolves for the link.
 * - `voice_bot` carries the display name, number, languages and description:
 *   never the key or domains.
 * - Every other key of the body is unchanged for existing link types.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { UserStoreFake, _setUserStore, buildCoordinator } from '../services/user-store/index.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { _setDbClients } from '../db/client.js';
import {
  _setRegistrationLinksStore,
  RegistrationLinksStoreBase,
  type RegistrationLink,
  type StoreResult,
} from '../services/registration-links-store/index.js';
import { _setSchemaLoader } from '../services/schema-loader/index.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import type { ResolvedNetworkConfig, VoiceBot } from '@aggregator-dpg/network-config/interface';

const { consumeMock } = vi.hoisted(() => ({
  consumeMock: vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 0 }),
}));
vi.mock('../services/rate-limiter/index.js', () => ({ consume: consumeMock }));

const AGG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_SLUG = 'acme';

const PHONE_A = '+919811100001';
const PHONE_B = '+919811100002';
const PHONE_C = '+919811100003';

const BOT_A: VoiceBot = {
  key: 'a',
  display_name: 'Asha',
  phone: PHONE_A,
  languages: ['hi', 'en'],
  domains: ['seeker'],
  description: 'Helps job seekers',
};
const BOT_B: VoiceBot = {
  key: 'b',
  display_name: 'Bina',
  phone: PHONE_B,
  languages: ['en'],
  domains: ['seeker'],
};
const BOT_C: VoiceBot = {
  key: 'c',
  display_name: 'Chitra',
  phone: PHONE_C,
  languages: ['en'],
  domains: ['seeker'],
};

/** Store serving a fixed set of links keyed by slug. */
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

const baseLink = {
  userId: AGG_ID,
  domain: 'seeker' as const,
  context: {},
  voiceBotKey: null,
  qrObjectKey: null,
  status: 'live' as const,
  expiresAt: null,
  createdBy: 'system',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

function link(id: string, slug: string, over: Partial<RegistrationLink>): RegistrationLink {
  return { ...baseLink, id, slug, registrationMode: 'form', ...over };
}

const LINKS: Record<string, RegistrationLink> = {
  legacy: link('22222222-2222-2222-2222-222222222221', 'legacy', { registrationMode: 'voice' }),
  named: link('22222222-2222-2222-2222-222222222222', 'named', {
    registrationMode: 'voice_or_form',
    voiceBotKey: 'a',
  }),
  gone: link('22222222-2222-2222-2222-222222222223', 'gone', {
    registrationMode: 'voice_or_form',
    voiceBotKey: 'gone',
  }),
  ambiguous: link('22222222-2222-2222-2222-222222222224', 'ambiguous', {
    registrationMode: 'voice_or_form',
    voiceBotKey: 'p',
  }),
  unnamed: link('22222222-2222-2222-2222-222222222225', 'unnamed', {
    registrationMode: 'voice_or_form',
  }),
};

/** Blue-dot config with a `voice_or_form` mode and the given bots. */
function configWith(
  voiceBots: VoiceBot[],
  defaults?: Record<string, string>,
): ResolvedNetworkConfig {
  const base = buildBlueDotConfig();
  return {
    ...base,
    aggregator: {
      ...base.aggregator,
      voice_bots: voiceBots,
      default_voice_bots: defaults,
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

async function bootApp(cfg: ResolvedNetworkConfig): Promise<FastifyInstance> {
  consumeMock.mockClear();
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
      signalstackOrgId: 'org-signalstack-1',
    }),
  ]);
  _setUserStore(aggStore);
  _setRegistrationLinksStore(new LinksStore(LINKS));
  _setDbClients(null, null);
  return buildApp();
}

async function teardown(app: FastifyInstance | undefined): Promise<void> {
  await app?.close();
  _setUserStore(null);
  _setRegistrationLinksStore(null);
  _setNetworkConfig(null);
  _setDbClients(null, null);
  _setSchemaLoader(null);
}

async function resolve(app: FastifyInstance, slug: string) {
  const r = await app.inject({
    method: 'GET',
    url: `/public/v1/aggregators/${ORG_SLUG}/links/${slug}`,
  });
  expect(r.statusCode).toBe(200);
  return { body: r.json(), raw: r.body };
}

describe('GET /public/v1/aggregators/:org/links/:slug — offers and voice_bot', () => {
  let app: FastifyInstance | undefined;
  afterEach(() => teardown(app));

  describe('with bots a and b serving seeker, default b', () => {
    beforeEach(async () => {
      app = await bootApp(configWith([BOT_A, BOT_B], { seeker: 'b' }));
    });

    it('leaves an existing voice link as before, plus offers form and no bot', async () => {
      const { body } = await resolve(app!, 'legacy');
      const { offers, voice_bot, ...rest } = body;
      expect(offers).toEqual(['form']);
      expect(voice_bot).toBeNull();
      expect(rest).toEqual({
        slug: 'legacy',
        network: 'blue_dot',
        domain: 'seeker',
        context: {},
        registration_mode: 'voice',
        submission_shape: 'account_only',
        public_hint_i18n_key: 'registration_mode.voice.hint',
        schema_id: null,
        schema_version: null,
        schema: null,
        identity: expect.any(Object),
        expires_at: null,
      });
    });

    it('offers voice and form with the named bot and its number', async () => {
      const { body, raw } = await resolve(app!, 'named');
      expect(body.offers).toEqual(['voice', 'form']);
      expect(body.voice_bot).toEqual({
        display_name: 'Asha',
        phone: PHONE_A,
        languages: ['hi', 'en'],
        description: 'Helps job seekers',
      });
      expect(body.schema).not.toBeNull();
      expect(raw).not.toContain('"key":"a"');
      expect(raw).not.toContain('domains');
    });

    it('falls back to the domain default when the named key is gone', async () => {
      const { body } = await resolve(app!, 'gone');
      expect(body.offers).toEqual(['voice', 'form']);
      expect(body.voice_bot.display_name).toBe('Bina');
      expect(body.voice_bot.phone).toBe(PHONE_B);
    });

    it('uses the domain default for a link naming no bot', async () => {
      const { body } = await resolve(app!, 'unnamed');
      expect(body.voice_bot.display_name).toBe('Bina');
    });

    it('shows a display name changed in the config on the next resolve', async () => {
      expect((await resolve(app!, 'named')).body.voice_bot.display_name).toBe('Asha');
      _setNetworkConfig(configWith([{ ...BOT_A, display_name: 'Asha Devi' }, BOT_B]));
      expect((await resolve(app!, 'named')).body.voice_bot.display_name).toBe('Asha Devi');
    });
  });

  it('drops voice when the key is gone and two bots serve the domain with no default', async () => {
    app = await bootApp(configWith([BOT_B, BOT_C]));
    const { body } = await resolve(app, 'ambiguous');
    expect(body.offers).toEqual(['form']);
    expect(body.voice_bot).toBeNull();
  });

  it('keeps the form path working when no voice bots are configured', async () => {
    app = await bootApp(configWith([]));
    const { body } = await resolve(app, 'unnamed');
    expect(body.offers).toEqual(['form']);
    expect(body.voice_bot).toBeNull();
    expect(body.schema).not.toBeNull();
  });
});
