/**
 * Shared fakes and fixtures for the QR links apply and command tests.
 */
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import type { ResolvedNetworkConfig, VoiceBot } from '@aggregator-dpg/network-config/interface';
import { buildCoordinator, UserStoreFake } from '../../services/user-store/index.js';
import {
  RegistrationLinksStoreBase,
  type CreateRegistrationLinkInput,
  type RegistrationLink,
  type StoreResult,
} from '../../services/registration-links-store/index.js';

export const NOW = new Date('2026-11-20T10:00:00Z');
export const RAJ_ID = '00000000-0000-4000-8000-0000000000a1';
export const MEERA_ID = '00000000-0000-4000-8000-0000000000a2';
export const LINKS_HEADER = 'coordinator_email,profile_type,voice_bot,link_name,expires_on';

/** Links store fake that keeps created links and can fail a given create call. */
export class LinksStoreFake extends RegistrationLinksStoreBase {
  readonly rows: RegistrationLink[] = [];
  readonly creates: CreateRegistrationLinkInput[] = [];
  /** 1-based create call that fails with DB_UNAVAILABLE. */
  failCreateCall: number | null = null;
  /** When set, `create` never settles. */
  hangCreate = false;

  async create(input: CreateRegistrationLinkInput): Promise<StoreResult<RegistrationLink>> {
    this.creates.push(input);
    if (this.hangCreate) return new Promise(() => undefined);
    if (this.failCreateCall === this.creates.length) {
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'down' } };
    }
    if (this.rows.some((r) => r.slug === input.slug && r.aggregatorId === input.aggregatorId)) {
      return { ok: false, error: { code: 'SLUG_COLLISION', message: 'taken' } };
    }
    const link: RegistrationLink = {
      id: `link-${this.rows.length + 1}`,
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
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.rows.push(link);
    return { ok: true, value: link };
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

export function bot(key: string, domains: string[]): VoiceBot {
  return { key, display_name: key, phone: '+919000000001', languages: ['en'], domains };
}

/** blue_dot config with the two-option mode and the given bots. */
export function twoOptionConfig(
  bots: VoiceBot[] = [bot('bot_a', ['seeker'])],
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
    },
  };
}

/** A user store with two active coordinators: Raj (seeker, provider) and Meera (seeker). */
export function seededUsers(): UserStoreFake {
  const users = new UserStoreFake();
  users.seed([
    buildCoordinator({
      id: RAJ_ID,
      orgSlug: 'raj-org',
      status: 'active',
      serves: ['seeker', 'provider'],
      signalstackOrgId: 'ss-raj',
      contactEmail: 'raj@x.org',
      contact: { name: 'Raj', email: 'raj@x.org', phone: '+919876500001' },
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
  return users;
}
