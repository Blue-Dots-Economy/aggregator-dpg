import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import type { ResolvedNetworkConfig, VoiceBot } from '@aggregator-dpg/network-config/interface';
import { _setNetworkConfig } from '../../network-config.js';
import {
  _setRegistrationLinksStore,
  RegistrationLinksStoreBase,
  type CreateRegistrationLinkInput,
  type RegistrationLink,
  type StoreResult,
} from '../../registration-links-store/index.js';
import { buildPublicUrl, createRegistrationLink, type CreateLinkInput } from '../create.js';

const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
const AGG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_SLUG = 'acme';

/** Store fake: records creates and refuses the slugs in `taken`. */
class FakeLinksStore extends RegistrationLinksStoreBase {
  readonly creates: CreateRegistrationLinkInput[] = [];
  readonly taken = new Set<string>();

  async create(input: CreateRegistrationLinkInput): Promise<StoreResult<RegistrationLink>> {
    this.creates.push(input);
    if (this.taken.has(input.slug)) {
      return { ok: false, error: { code: 'SLUG_COLLISION', message: 'taken' } };
    }
    const now = new Date();
    return {
      ok: true,
      value: {
        id: `link-${this.creates.length}`,
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
      },
    };
  }
  async findById(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async findBySlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async findByOrgAndSlug(): Promise<StoreResult<RegistrationLink | null>> {
    return { ok: true, value: null };
  }
  async updateDraft(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'unused' } };
  }
  async list(): Promise<StoreResult<{ rows: RegistrationLink[]; total: number }>> {
    return { ok: true, value: { rows: [], total: 0 } };
  }
  async updateStatus(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'unused' } };
  }
}

const BOT_A: VoiceBot = {
  key: 'a',
  display_name: 'Bot A',
  phone: '+919000000001',
  languages: ['en'],
  domains: ['seeker'],
};

/** blue_dot config with a `voice_or_form` mode and seeker bot `a` as the only bot. */
function voiceConfig(): ResolvedNetworkConfig {
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
      voice_bots: [BOT_A],
    },
  };
}

function input(overrides: Partial<CreateLinkInput> = {}): CreateLinkInput {
  return {
    userId: AGG_ID,
    orgSlug: ORG_SLUG,
    servedDomains: ['seeker'],
    domain: 'seeker',
    context: {},
    status: 'live',
    createdBy: 'kc-user-1',
    log,
    ...overrides,
  };
}

describe('createRegistrationLink', () => {
  let store: FakeLinksStore;

  beforeEach(() => {
    store = new FakeLinksStore();
    _setRegistrationLinksStore(store);
    _setNetworkConfig(voiceConfig());
  });

  afterEach(() => {
    _setRegistrationLinksStore(null);
    _setNetworkConfig(null);
  });

  it('stores the default voice bot on a live link and returns its public URL', async () => {
    const r = await createRegistrationLink(
      input({ registrationMode: 'voice_or_form', slug: 'gate-1' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(store.creates[0]?.voiceBotKey).toBe('a');
    expect(store.creates[0]?.aggregatorId).toBe(AGG_ID);
    expect(r.value.link.voiceBotKey).toBe('a');
    expect(r.value.link.status).toBe('live');
    expect(r.value.publicUrl).toBe(buildPublicUrl(ORG_SLUG, 'gate-1'));
    expect(r.value.publicUrl).toMatch(/\/acme\/gate-1$/);
  });

  it('refuses a domain the coordinator does not serve', async () => {
    const r = await createRegistrationLink(input({ domain: 'provider' }));
    expect(!r.ok && r.error.code).toBe('DOMAIN_NOT_SERVED');
    expect(store.creates).toHaveLength(0);
  });

  it('refuses a domain the network does not declare', async () => {
    const r = await createRegistrationLink(input({ domain: 'nope' }));
    expect(!r.ok && r.error.code).toBe('SCHEMA_VALIDATION');
  });

  it('refuses a mode the network does not declare', async () => {
    const r = await createRegistrationLink(input({ registrationMode: 'carrier_pigeon' }));
    expect(!r.ok && r.error.code).toBe('INVALID_REGISTRATION_MODE');
    expect(store.creates).toHaveLength(0);
  });

  it('retries a colliding slug with a random suffix', async () => {
    store.taken.add('gate-1');
    const r = await createRegistrationLink(input({ slug: 'gate-1' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(store.creates).toHaveLength(2);
    expect(r.value.link.slug).toMatch(/^gate-1-[0-9a-f]{4}$/);
    expect(r.value.publicUrl).toBe(buildPublicUrl(ORG_SLUG, r.value.link.slug));
  });

  it('refuses with DUPLICATE_SLUG when every attempt collides', async () => {
    const always = new (class extends FakeLinksStore {
      override async create(i: CreateRegistrationLinkInput) {
        this.creates.push(i);
        return { ok: false as const, error: { code: 'SLUG_COLLISION' as const, message: 'x' } };
      }
    })();
    _setRegistrationLinksStore(always);
    const r = await createRegistrationLink(input({ slug: 'gate-1' }));
    expect(!r.ok && r.error.code).toBe('DUPLICATE_SLUG');
  });

  it('returns a null public URL for a draft', async () => {
    const r = await createRegistrationLink(input({ status: 'draft' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.link.status).toBe('draft');
    expect(r.value.publicUrl).toBeNull();
  });
});
