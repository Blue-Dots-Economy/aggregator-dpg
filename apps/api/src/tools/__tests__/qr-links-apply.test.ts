import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logger.js';
import { _setNetworkConfig } from '../../services/network-config.js';
import { _setUserStore } from '../../services/user-store/index.js';
import { _setRegistrationLinksStore } from '../../services/registration-links-store/index.js';
import type { RegistrationLink } from '../../services/registration-links-store/index.js';
import { buildPublicUrl } from '../../services/registration-links/create.js';
import { parseLinksCsv } from '../qr-links-input.js';
import { buildLinksPlan } from '../qr-links-plan.js';
import { applyLinksPlan, type LinkReportRow } from '../qr-links-apply.js';
import {
  LINKS_HEADER as HEADER,
  LinksStoreFake,
  MEERA_ID,
  NOW,
  RAJ_ID,
  seededUsers,
  twoOptionConfig,
} from './qr-links-fixtures.js';

let links: LinksStoreFake;
const log = logger.child({ test: 'qr-links-apply' });

beforeEach(() => {
  _setUserStore(seededUsers());
  links = new LinksStoreFake();
  _setRegistrationLinksStore(links);
  _setNetworkConfig(twoOptionConfig());
});

afterEach(() => {
  _setUserStore(null);
  _setRegistrationLinksStore(null);
  vi.unstubAllEnvs();
});

/** Parses, plans and applies a sheet. */
async function load(lines: string[], callTimeoutMs?: number) {
  const parsed = parseLinksCsv(`${[HEADER, ...lines].join('\n')}\n`);
  const plan = await buildLinksPlan({
    rows: parsed.rows,
    inputProblems: parsed.problems,
    now: NOW,
  });
  expect(plan.problems).toEqual([]);
  return applyLinksPlan(plan, {
    operator: 'asha',
    log,
    ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
  });
}

const SHEET = ['raj@x.org,seeker,,camp-a,', 'meera@x.org,seeker,bot_a,,2026-12-31'];

describe('applyLinksPlan', () => {
  it('creates live two-option links created by the coordinator', async () => {
    const { rows, failed } = await load(SHEET);
    expect(failed).toBe(false);
    expect(links.creates).toHaveLength(2);
    for (const c of links.creates) {
      expect(c.status).toBe('live');
      expect(c.registrationMode).toBe('voice_or_form');
      expect(c.createdBy).toBe(c.aggregatorId);
    }
    expect(links.creates.map((c) => c.createdBy)).toEqual([RAJ_ID, MEERA_ID]);
    expect(links.creates[1]?.expiresAt).toEqual(new Date('2026-12-31T23:59:59.999Z'));
    const meeraSlug = links.rows[1]?.slug ?? '';
    expect(rows).toEqual<LinkReportRow[]>([
      {
        line: 2,
        coordinatorEmail: 'raj@x.org',
        profileType: 'seeker',
        voiceBot: 'bot_a',
        slug: 'camp-a',
        url: buildPublicUrl('raj-org', 'camp-a'),
        outcome: 'created',
        errorCode: '',
      },
      {
        line: 3,
        coordinatorEmail: 'meera@x.org',
        profileType: 'seeker',
        voiceBot: 'bot_a',
        slug: meeraSlug,
        url: buildPublicUrl('meera-org', meeraSlug),
        outcome: 'created',
        errorCode: '',
      },
    ]);
  });

  it('reports already_loaded with the existing URL on a rerun and creates nothing (Review Focus 2)', async () => {
    links.failCreateCall = 2;
    const first = await load(SHEET);
    expect(first.rows.map((r) => r.outcome)).toEqual(['created', 'failed']);
    expect(links.rows).toHaveLength(1);

    links.failCreateCall = null;
    const second = await load(SHEET);
    expect(second.failed).toBe(false);
    expect(second.rows.map((r) => r.outcome)).toEqual(['already_loaded', 'created']);
    expect(second.rows[0]).toMatchObject({
      slug: 'camp-a',
      url: buildPublicUrl('raj-org', 'camp-a'),
      voiceBot: 'bot_a',
      errorCode: '',
    });
    // Two failed or created creates on the first run, one on the second: never the loaded row.
    expect(links.creates.map((c) => c.aggregatorId)).toEqual([RAJ_ID, MEERA_ID, MEERA_ID]);

    const third = await load(SHEET);
    expect(third.rows.map((r) => r.outcome)).toEqual(['already_loaded', 'already_loaded']);
    expect(links.creates).toHaveLength(3);
    expect(links.rows).toHaveLength(2);
  });

  it('leaves voice_bot blank when no bot is configured (Review Focus 4)', async () => {
    _setNetworkConfig(twoOptionConfig([]));
    const { rows } = await load(['raj@x.org,seeker,,,']);
    expect(rows[0]).toMatchObject({ outcome: 'created', voiceBot: '' });
    expect(links.creates[0]?.voiceBotKey).toBeNull();
  });

  it('stops at the first failure and leaves the rest not_run', async () => {
    links.failCreateCall = 2;
    const { rows, failed } = await load([...SHEET, 'raj@x.org,provider,,,']);
    expect(failed).toBe(true);
    expect(rows.map((r) => [r.outcome, r.errorCode])).toEqual([
      ['created', ''],
      ['failed', 'DB_UNAVAILABLE'],
      ['not_run', ''],
    ]);
    expect(rows[1]).toMatchObject({ slug: '', url: '' });
    expect(links.creates).toHaveLength(2);
  });

  it('fails the row with CALL_TIMEOUT when the create hangs', async () => {
    links.hangCreate = true;
    const { rows, failed } = await load(SHEET, 20);
    expect(failed).toBe(true);
    expect(rows.map((r) => [r.outcome, r.errorCode])).toEqual([
      ['failed', 'CALL_TIMEOUT'],
      ['not_run', ''],
    ]);
  });

  it('refuses a sheet whose link name a retired link holds, and creates nothing', async () => {
    links.rows.push({ ...retiredCamp() });
    const parsed = parseLinksCsv(`${[HEADER, 'raj@x.org,seeker,,camp,'].join('\n')}\n`);
    const plan = await buildLinksPlan({
      rows: parsed.rows,
      inputProblems: parsed.problems,
      now: NOW,
    });
    expect(plan.problems.map((p) => p.code)).toEqual(['LINK_NAME_TAKEN']);
    await expect(applyLinksPlan(plan, { operator: 'asha', log })).rejects.toMatchObject({
      code: 'PLAN_HAS_PROBLEMS',
    });
    expect(links.creates).toEqual([]);
  });

  it('refuses a plan with problems and an invalid operator', async () => {
    await expect(
      applyLinksPlan(
        { links: [], problems: [{ line: 2, code: 'REQUIRED' }] },
        {
          operator: 'asha',
          log,
        },
      ),
    ).rejects.toMatchObject({ code: 'PLAN_HAS_PROBLEMS' });
    await expect(
      applyLinksPlan({ links: [], problems: [] }, { operator: 'a b', log }),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATOR' });
  });
});

/** A retired two-option link of Raj's with slug `camp`. */
function retiredCamp(): RegistrationLink {
  return {
    id: 'retired-camp',
    aggregatorId: RAJ_ID,
    slug: 'camp',
    domain: 'seeker',
    context: {},
    registrationMode: 'voice_or_form',
    voiceBotKey: 'bot_a',
    qrObjectKey: null,
    status: 'retired',
    expiresAt: null,
    createdBy: RAJ_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
