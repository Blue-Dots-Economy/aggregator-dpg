import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import type { ResolvedNetworkConfig, VoiceBot } from '@aggregator-dpg/network-config/interface';
import { logger } from '../../logger.js';
import { _setNetworkConfig } from '../../services/network-config.js';
import { UserStoreFake, buildCoordinator, _setUserStore } from '../../services/user-store/index.js';
import {
  _setRegistrationLinksStore,
  RegistrationLinksStoreBase,
  type RegistrationLink,
  type StoreResult,
} from '../../services/registration-links-store/index.js';
import { buildPublicUrl } from '../../services/registration-links/create.js';
import type { InputProblem, LinkRow } from '../qr-links-input.js';
import { LINK_INPUT_PROBLEM } from '../qr-links-input.js';
import { QR_PLAN_PROBLEM, buildLinksPlan } from '../qr-links-plan.js';

const NOW = new Date('2026-11-20T10:00:00Z');
const RAJ_ID = '00000000-0000-4000-8000-0000000000a1';
const MEERA_ID = '00000000-0000-4000-8000-0000000000a2';

/** Links store fake holding seeded rows; only `list` is used by the plan. */
class LinksStoreFake extends RegistrationLinksStoreBase {
  readonly rows: RegistrationLink[] = [];
  failList = false;
  hangList = false;

  async create(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'unused' } };
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
  async list(
    aggregatorId: string,
    options: { status?: RegistrationLink['status']; limit: number; offset: number },
  ): Promise<StoreResult<{ rows: RegistrationLink[]; total: number }>> {
    if (this.hangList) return new Promise(() => undefined);
    if (this.failList) return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'down' } };
    const mine = this.rows.filter(
      (r) => r.aggregatorId === aggregatorId && (!options.status || r.status === options.status),
    );
    return {
      ok: true,
      value: {
        rows: mine.slice(options.offset, options.offset + options.limit),
        total: mine.length,
      },
    };
  }
  async updateStatus(): Promise<StoreResult<RegistrationLink>> {
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'unused' } };
  }
}

function bot(key: string, domains: string[]): VoiceBot {
  return { key, display_name: key, phone: '+919000000001', languages: ['en'], domains };
}

/** blue_dot config with the two-option mode and the given bots and defaults. */
function twoOptionConfig(
  bots: VoiceBot[] = [bot('bot_a', ['seeker'])],
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
      voice_bots: bots,
      ...(defaults ? { default_voice_bots: defaults } : {}),
    },
  };
}

function link(overrides: Partial<RegistrationLink>): RegistrationLink {
  return {
    id: 'link-1',
    aggregatorId: RAJ_ID,
    slug: 'existing',
    domain: 'seeker',
    context: {},
    registrationMode: 'voice_or_form',
    voiceBotKey: 'bot_a',
    qrObjectKey: null,
    status: 'live',
    expiresAt: null,
    createdBy: RAJ_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

let nextLine = 2;
function row(overrides: Partial<LinkRow> = {}): LinkRow {
  return {
    line: nextLine++,
    coordinatorEmail: 'raj@x.org',
    profileType: 'seeker',
    voiceBot: '',
    linkName: '',
    expiresOn: '',
    ...overrides,
  };
}

let users: UserStoreFake;
let links: LinksStoreFake;

beforeEach(() => {
  nextLine = 2;
  users = new UserStoreFake();
  users.seed([
    buildCoordinator({
      id: RAJ_ID,
      orgSlug: 'raj-org',
      status: 'active',
      serves: ['seeker', 'provider'],
      signalstackOrgId: 'ss-raj',
      contactEmail: 'raj@x.org',
      contact: { name: 'Raj', email: 'Raj@X.org', phone: '+919876500001' },
    }),
    buildCoordinator({
      id: MEERA_ID,
      orgSlug: 'meera-org',
      status: 'active',
      serves: ['seeker'],
      signalstackOrgId: 'ss-meera',
      contactEmail: 'meera@x.org',
      contact: { name: 'Meera', email: 'meera@x.org', phone: '+919876500002' },
    }),
  ]);
  _setUserStore(users);
  links = new LinksStoreFake();
  _setRegistrationLinksStore(links);
  _setNetworkConfig(twoOptionConfig());
});

afterEach(() => {
  vi.restoreAllMocks();
  _setUserStore(null);
  _setRegistrationLinksStore(null);
  vi.unstubAllEnvs();
});

async function plan(rows: LinkRow[], inputProblems: InputProblem[] = []) {
  return buildLinksPlan({ rows, inputProblems, now: NOW });
}

function codes(problems: InputProblem[]): string[] {
  return problems.map((p) => p.code);
}

describe('buildLinksPlan', () => {
  it('plans a clean row with the resolved bot, slug and expiry', async () => {
    const r = row({ linkName: 'camp-1', expiresOn: '2026-12-31' });
    const { links: planned, problems } = await plan([r]);
    expect(problems).toEqual([]);
    expect(planned).toEqual([
      {
        row: r,
        userId: RAJ_ID,
        orgSlug: 'raj-org',
        domain: 'seeker',
        registrationMode: 'voice_or_form',
        voiceBotKey: 'bot_a',
        slug: 'camp-1',
        expiresAt: new Date('2026-12-31T23:59:59.999Z'),
        existing: null,
      },
    ]);
  });

  it('matches a coordinator email with other case and spaces (Review Focus 1)', async () => {
    const { links: planned, problems } = await plan([row({ coordinatorEmail: ' Raj@X.org ' })]);
    expect(problems).toEqual([]);
    expect(planned[0]?.userId).toBe(RAJ_ID);
  });

  it('reports an unknown coordinator', async () => {
    const { problems } = await plan([row({ coordinatorEmail: 'nobody@x.org' })]);
    expect(problems).toEqual([
      { line: 2, code: QR_PLAN_PROBLEM.UNKNOWN_COORDINATOR, field: 'coordinator_email' },
    ]);
  });

  it('reports a coordinator who is not active', async () => {
    users.seed([
      buildCoordinator({
        id: '00000000-0000-4000-8000-0000000000a3',
        orgSlug: 'p-org',
        status: 'pending',
        serves: ['seeker'],
        signalstackOrgId: 'ss-p',
        contactEmail: 'pending@x.org',
        contact: { name: 'P', email: 'pending@x.org', phone: '+919876500003' },
      }),
    ]);
    const { problems } = await plan([row({ coordinatorEmail: 'pending@x.org' })]);
    expect(codes(problems)).toEqual([QR_PLAN_PROBLEM.COORDINATOR_NOT_ACTIVE]);
  });

  it('reports a coordinator with no Signals org', async () => {
    users.seed([
      buildCoordinator({
        id: '00000000-0000-4000-8000-0000000000a4',
        orgSlug: 'n-org',
        status: 'active',
        serves: ['seeker'],
        signalstackOrgId: null,
        contactEmail: 'noorg@x.org',
        contact: { name: 'N', email: 'noorg@x.org', phone: '+919876500004' },
      }),
    ]);
    const { problems } = await plan([row({ coordinatorEmail: 'noorg@x.org' })]);
    expect(codes(problems)).toEqual([QR_PLAN_PROBLEM.NO_SIGNALS_ORG]);
  });

  it('reports a profile type the coordinator does not serve, or that is unknown', async () => {
    const { problems } = await plan([
      row({ coordinatorEmail: 'meera@x.org', profileType: 'provider' }),
      row({ profileType: 'alien' }),
    ]);
    expect(problems).toEqual([
      { line: 2, code: QR_PLAN_PROBLEM.DOMAIN_NOT_SERVED, field: 'profile_type' },
      { line: 3, code: QR_PLAN_PROBLEM.DOMAIN_NOT_SERVED, field: 'profile_type' },
    ]);
  });

  it('reports an unknown voice bot and one that does not serve the profile type', async () => {
    _setNetworkConfig(twoOptionConfig([bot('bot_a', ['seeker']), bot('bot_p', ['provider'])]));
    const { problems } = await plan([
      row({ voiceBot: 'nope', linkName: 'one' }),
      row({ voiceBot: 'bot_p', linkName: 'two' }),
    ]);
    expect(problems).toEqual([
      { line: 2, code: QR_PLAN_PROBLEM.UNKNOWN_VOICE_BOT, field: 'voice_bot' },
      { line: 3, code: QR_PLAN_PROBLEM.VOICE_BOT_NOT_FOR_DOMAIN, field: 'voice_bot' },
    ]);
  });

  it('requires a voice bot when several serve the type and none is the default', async () => {
    _setNetworkConfig(twoOptionConfig([bot('bot_a', ['seeker']), bot('bot_b', ['seeker'])]));
    const { problems, links: planned } = await plan([
      row(),
      row({ voiceBot: 'bot_b', linkName: 'bbb' }),
    ]);
    expect(problems).toEqual([
      { line: 2, code: QR_PLAN_PROBLEM.VOICE_BOT_REQUIRED, field: 'voice_bot' },
    ]);
    expect(planned.map((p) => p.voiceBotKey)).toEqual(['bot_b']);
  });

  it('uses the default bot when several serve the type', async () => {
    _setNetworkConfig(
      twoOptionConfig([bot('bot_a', ['seeker']), bot('bot_b', ['seeker'])], { seeker: 'bot_b' }),
    );
    const { problems, links: planned } = await plan([row()]);
    expect(problems).toEqual([]);
    expect(planned[0]?.voiceBotKey).toBe('bot_b');
  });

  it('plans a null bot when no bot is configured', async () => {
    _setNetworkConfig(twoOptionConfig([]));
    const { problems, links: planned } = await plan([row()]);
    expect(problems).toEqual([]);
    expect(planned[0]?.voiceBotKey).toBeNull();
  });

  it('reports an invalid link name', async () => {
    const { problems } = await plan([
      row({ linkName: 'Camp_1' }),
      row({ linkName: 'ab' }),
      row({ linkName: 'a'.repeat(61) }),
    ]);
    expect(codes(problems)).toEqual([
      QR_PLAN_PROBLEM.INVALID_LINK_NAME,
      QR_PLAN_PROBLEM.INVALID_LINK_NAME,
      QR_PLAN_PROBLEM.INVALID_LINK_NAME,
    ]);
    expect(problems[0]?.field).toBe('link_name');
  });

  it('reports an unparseable expiry and one in the past', async () => {
    const { problems } = await plan([
      row({ expiresOn: '31/12/2026', linkName: 'a1a' }),
      row({ expiresOn: '2026-02-30', linkName: 'a2a' }),
      row({ expiresOn: '2026-11-19', linkName: 'a3a' }),
    ]);
    expect(problems).toEqual([
      { line: 2, code: QR_PLAN_PROBLEM.INVALID_EXPIRY, field: 'expires_on' },
      { line: 3, code: QR_PLAN_PROBLEM.INVALID_EXPIRY, field: 'expires_on' },
      { line: 4, code: QR_PLAN_PROBLEM.EXPIRY_IN_PAST, field: 'expires_on' },
    ]);
  });

  it('accepts an expiry of today, read as the end of the day in UTC', async () => {
    const { problems, links: planned } = await plan([row({ expiresOn: '2026-11-20' })]);
    expect(problems).toEqual([]);
    expect(planned[0]?.expiresAt).toEqual(new Date('2026-11-20T23:59:59.999Z'));
  });

  it('allows one link name for two coordinators but not twice for one (Review Focus 3)', async () => {
    const { problems } = await plan([
      row({ linkName: 'camp' }),
      row({ coordinatorEmail: 'meera@x.org', linkName: 'camp' }),
      row({ coordinatorEmail: 'RAJ@x.org', linkName: 'camp' }),
      row({ profileType: 'provider', linkName: 'camp' }),
    ]);
    expect(problems).toEqual([{ line: 4, code: QR_PLAN_PROBLEM.DUPLICATE_ROW }]);
  });

  it('treats two unnamed rows for one coordinator and type as duplicates', async () => {
    const { problems } = await plan([row(), row()]);
    expect(problems).toEqual([{ line: 3, code: QR_PLAN_PROBLEM.DUPLICATE_ROW }]);
  });

  it('reports the mode when the two-option mode is not enabled', async () => {
    vi.stubEnv('AGGREGATOR_ONBOARDING_ENABLED', 'form,voice');
    const { problems } = await plan([row()]);
    expect(problems).toEqual([
      { line: 1, code: QR_PLAN_PROBLEM.MODE_NOT_ENABLED, field: 'registration_mode' },
    ]);
  });

  it('reports the mode when the network declares no two-option mode', async () => {
    _setNetworkConfig(buildBlueDotConfig());
    const { problems } = await plan([row()]);
    expect(codes(problems)).toEqual([QR_PLAN_PROBLEM.MODE_NOT_ENABLED]);
  });

  it('sets existing for a live two-option link of that coordinator and type', async () => {
    links.rows.push(
      link({ id: 'f', slug: 'form-link', registrationMode: 'form' }),
      link({ id: 'p', slug: 'prov', domain: 'provider' }),
      link({ id: 'r', slug: 'retired', status: 'retired' }),
      link({ id: 'v', slug: 'voice-link' }),
    );
    const { problems, links: planned } = await plan([row()]);
    expect(problems).toEqual([]);
    expect(planned[0]?.existing).toEqual({
      slug: 'voice-link',
      url: buildPublicUrl('raj-org', 'voice-link'),
      voiceBotKey: 'bot_a',
    });
  });

  it('matches existing by slug when a link name is given', async () => {
    links.rows.push(link({ slug: 'other' }), link({ id: 'c', slug: 'camp' }));
    const { links: planned } = await plan([row({ linkName: 'camp' }), row({ linkName: 'fresh' })]);
    expect(planned.map((p) => p.existing?.slug ?? null)).toEqual(['camp', null]);
  });

  it('ignores an expired live link', async () => {
    links.rows.push(link({ expiresAt: new Date('2026-11-01T00:00:00Z') }));
    const { links: planned } = await plan([row()]);
    expect(planned[0]?.existing).toBeNull();
  });

  it('keeps input problems and does not plan their rows', async () => {
    const bad = row();
    const input: InputProblem[] = [{ line: bad.line, code: LINK_INPUT_PROBLEM.MALFORMED_ROW }];
    const { links: planned, problems } = await plan([bad], input);
    expect(planned).toEqual([]);
    expect(problems).toEqual(input);
  });

  it('reports a failed lookup as a problem on the row', async () => {
    links.failList = true;
    const { links: planned, problems } = await plan([row()]);
    expect(planned).toEqual([]);
    expect(problems).toEqual([{ line: 2, code: QR_PLAN_PROBLEM.CHECK_FAILED }]);
  });
  it('logs the error code and store reason of a failed row check', async () => {
    const spy = vi.spyOn(logger, 'error');
    links.failList = true;
    await plan([row()]);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'qrLinks.buildLinksPlan.check',
        line: 2,
        error_code: 'PLAN_LOOKUP_FAILED',
        reason: 'DB_UNAVAILABLE',
      }),
      expect.any(String),
    );
  });

  it('reports a lookup that times out as CHECK_FAILED on the row', async () => {
    links.hangList = true;
    const { links: planned, problems } = await buildLinksPlan({
      rows: [row()],
      inputProblems: [],
      now: NOW,
      callTimeoutMs: 20,
    });
    expect(planned).toEqual([]);
    expect(problems).toEqual([{ line: 2, code: QR_PLAN_PROBLEM.CHECK_FAILED }]);
  });

  it('plans the first two-option mode that is enabled, with its key on the link', async () => {
    const cfg = twoOptionConfig();
    const declared = cfg.aggregator.registration_modes;
    const twoOption = declared['voice_or_form'];
    if (!twoOption) throw new Error('fixture has no voice_or_form');
    _setNetworkConfig({
      ...cfg,
      aggregator: {
        ...cfg.aggregator,
        registration_modes: { ...declared, voice_or_form_b: twoOption },
      },
    });
    vi.stubEnv('AGGREGATOR_ONBOARDING_ENABLED', 'form,voice_or_form_b');
    const { links: planned, problems } = await plan([row()]);
    expect(problems).toEqual([]);
    expect(planned[0]?.registrationMode).toBe('voice_or_form_b');
  });
});
