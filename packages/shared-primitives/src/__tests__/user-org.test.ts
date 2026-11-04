import { describe, it, expect } from 'vitest';
import {
  UserOrgStatusSchema,
  OrgTypeSchema,
  PersonContactSchema,
  CursorSchema,
  PageLimitSchema,
  DecisionReasonSchema,
  UserSchema,
  MeOrgSchema,
  MeResponseSchema,
  UserSearchRequestSchema,
  UserSearchResponseSchema,
  UserInviteRequestSchema,
  UserInviteResponseSchema,
  DecisionRequestSchema,
  DecisionResponseSchema,
  UserMetadataUpdateRequestSchema,
  OrgSchema,
  OrgReadResponseSchema,
  OrgSearchRequestSchema,
  OrgSearchResponseSchema,
  OrgMetadataUpdateRequestSchema,
  OrgDecisionResponseSchema,
  OrgHierarchyResponseSchema,
  OrgParentUpdateRequestSchema,
  OrgParentOptionsResponseSchema,
  OwnerAccessResponseSchema,
  KnownAsEntrySchema,
  KnownAsEntryRequestSchema,
  ChildKnownAsSchema,
  ChildKnownAsRequestSchema,
  OrgKnownAsUpdateRequestSchema,
  OrgChildKnownAsUpdateRequestSchema,
  KNOWN_AS_MAX_VALUES,
  KNOWN_AS_NAME_MAX,
  SYSTEM_KNOWN_AS,
} from '../user-org/index.js';

const contact = { name: 'A', email: 'a@x.test', phone: '+911234567890' };
const location = { geo: { type: 'Point', coordinates: [77.5946, 12.9716] } };

describe('user-org wire schemas', () => {
  it('accepts the lifecycle and org-type enums and rejects others', () => {
    for (const s of ['pending', 'active', 'inactive', 'retired']) {
      expect(UserOrgStatusSchema.parse(s)).toBe(s);
    }
    expect(UserOrgStatusSchema.safeParse('deleted').success).toBe(false);
    expect(OrgTypeSchema.parse('network_facilitator')).toBe('network_facilitator');
    expect(OrgTypeSchema.parse('aggregator')).toBe('aggregator');
    expect(OrgTypeSchema.safeParse('root').success).toBe(false);
  });

  it('PersonContact allows null name/phone but requires email', () => {
    expect(PersonContactSchema.parse({ name: null, email: 'e@x.test', phone: null })).toBeTruthy();
    expect(PersonContactSchema.safeParse({ name: 'a', phone: null }).success).toBe(false);
  });

  it('bounds cursor, page limit and decision reason', () => {
    expect(CursorSchema.safeParse('').success).toBe(false);
    expect(CursorSchema.parse('abc')).toBe('abc');
    expect(PageLimitSchema.safeParse(0).success).toBe(false);
    expect(PageLimitSchema.safeParse(101).success).toBe(false);
    expect(PageLimitSchema.parse(100)).toBe(100);
    expect(DecisionReasonSchema.parse('  spam  ')).toBe('spam');
    expect(DecisionReasonSchema.safeParse('   ').success).toBe(false);
    expect(DecisionReasonSchema.safeParse('x'.repeat(501)).success).toBe(false);
  });

  it('parses a coordinator User and the me response', () => {
    const user = {
      id: 'u1',
      user_type: 'coordinator' as const,
      status: 'active',
      name: 'Org A',
      contact,
      serves: ['agri'],
      org_id: 'o1',
      invited: true,
      created_at: 't',
      updated_at: 't',
      rejected_at: null,
    };
    expect(UserSchema.parse(user)).toBeTruthy();
    expect(UserSchema.safeParse({ ...user, user_type: 'admin' }).success).toBe(false);

    const org = {
      id: 'o1',
      name: 'Org A',
      slug: 'org-a',
      org_type: 'aggregator',
      role: 'owner',
      is_default: false,
    };
    expect(MeOrgSchema.parse(org)).toBeTruthy();
    expect(
      MeResponseSchema.parse({
        kind: 'admin',
        user: { id: 'u1', contact },
        orgs: [org],
        is_network_admin: true,
      }),
    ).toBeTruthy();
  });

  it('defaults the user search filter and enforces strictness', () => {
    const parsed = UserSearchRequestSchema.parse({});
    expect(parsed.filter).toEqual({});
    expect(
      UserSearchRequestSchema.parse({ filter: { status: 'pending', serves: 'agri' }, limit: 20 }),
    ).toBeTruthy();
    expect(UserSearchRequestSchema.safeParse({ filter: { org_id: 'not-a-uuid' } }).success).toBe(
      false,
    );
    expect(UserSearchRequestSchema.safeParse({ unknown: 1 }).success).toBe(false);
    expect(UserSearchResponseSchema.parse({ users: [], next_cursor: null })).toBeTruthy();
  });

  it('validates the invite request bounds and response shape', () => {
    expect(
      UserInviteRequestSchema.parse({
        org_id: '11111111-1111-1111-1111-111111111111',
        recipients: [{ email: 'a@x.test', name: 'A' }],
      }),
    ).toBeTruthy();
    // empty recipients and a short email are rejected
    expect(
      UserInviteRequestSchema.safeParse({
        org_id: '11111111-1111-1111-1111-111111111111',
        recipients: [],
      }).success,
    ).toBe(false);
    expect(
      UserInviteResponseSchema.parse({ sent: 1, resent: 0, invalid: [], existing: [] }),
    ).toBeTruthy();
  });

  it('validates decisions and the metadata updates', () => {
    expect(DecisionRequestSchema.parse({ decision: 'approve' })).toBeTruthy();
    expect(DecisionRequestSchema.parse({ decision: 'reject', reason: 'dup' })).toBeTruthy();
    expect(DecisionRequestSchema.safeParse({ decision: 'maybe' }).success).toBe(false);
    expect(
      DecisionResponseSchema.parse({ id: 'u1', status: 'active', notified: true }),
    ).toBeTruthy();

    expect(UserMetadataUpdateRequestSchema.parse({ serves: ['agri', 'edu'] })).toBeTruthy();
    expect(UserMetadataUpdateRequestSchema.parse({ serves: [] })).toBeTruthy();
    expect(UserMetadataUpdateRequestSchema.safeParse({ serves: Array(51).fill('x') }).success).toBe(
      false,
    );
  });

  it('parses org read/search responses', () => {
    const org = {
      id: 'o1',
      slug: 'org-a',
      name: 'Org A',
      org_type: 'aggregator',
      status: 'active',
      is_default: false,
      url: null,
      locations: [location],
      legal_name: null,
      known_as: 'aggregator',
      known_as_name: 'Aggregator',
      child_known_as: [{ key: 'district', name: 'District', default: true }],
      depth: 1,
      parent_id: 'root',
      parent_name: 'Network',
      description: null,
      profile: { website: 'https://x.test', domains: ['seeker'] },
      profile_ref: 'org-registration.v1',
      created_at: 't',
      updated_at: 't',
    };
    expect(OrgSchema.parse(org)).toBeTruthy();
    expect(OrgSchema.parse({ ...org, known_as: null, known_as_name: null })).toBeTruthy();
    expect(OrgSchema.safeParse({ ...org, known_as: undefined }).success).toBe(false);
    expect(OrgSchema.parse({ ...org, child_known_as: [] })).toBeTruthy();
    expect(OrgSchema.safeParse({ ...org, child_known_as: undefined }).success).toBe(false);
    expect(OrgSchema.parse({ ...org, depth: 0 })).toBeTruthy();
    expect(OrgSchema.safeParse({ ...org, depth: null }).success).toBe(false);
    expect(OrgSchema.safeParse({ ...org, depth: 1.5 }).success).toBe(false);
    expect(OrgSchema.safeParse({ ...org, depth: undefined }).success).toBe(false);
    expect(OrgSchema.parse({ ...org, parent_id: null, parent_name: null })).toBeTruthy();
    expect(OrgSchema.safeParse({ ...org, parent_id: undefined }).success).toBe(false);
    expect(
      OrgReadResponseSchema.parse({
        org,
        owner: { id: 'a1', contact },
        coordinator_count: 3,
        child_count: 2,
        pending_count: 1,
        known_as_options: [SYSTEM_KNOWN_AS],
        can_have_children: true,
      }),
    ).toBeTruthy();
    expect(
      OrgReadResponseSchema.parse({
        org,
        owner: { id: 'a1', contact },
        coordinator_count: 3,
        child_count: 2,
        pending_count: 1,
        known_as_options: null,
        can_have_children: false,
      }),
    ).toBeTruthy();
    expect(
      OrgReadResponseSchema.safeParse({
        org,
        owner: { id: 'a1', contact },
        coordinator_count: 3,
        child_count: 2,
        pending_count: 1,
        known_as_options: null,
      }).success,
    ).toBe(false);
    expect(
      OrgReadResponseSchema.safeParse({
        org,
        owner: { id: 'a1', contact },
        coordinator_count: 3,
        pending_count: 1,
      }).success,
    ).toBe(false);
    expect(OrgSearchRequestSchema.parse({ filter: { name_prefix: 'or' } })).toBeTruthy();
    expect(OrgSearchRequestSchema.parse({}).filter).toEqual({});
    expect(OrgSearchRequestSchema.safeParse({ filter: { known_as: 'state' } }).success).toBe(false);
    expect(
      OrgSearchRequestSchema.parse({
        filter: { descendants_of: '00000000-0000-4000-8000-000000000001' },
      }),
    ).toBeTruthy();
    expect(
      OrgSearchRequestSchema.safeParse({ filter: { descendants_of: 'not-a-uuid' } }).success,
    ).toBe(false);
    expect(
      OrgSearchResponseSchema.parse({
        orgs: [{ ...org, coordinator_count: 3, child_count: 0, pending_count: 1 }],
        next_cursor: null,
      }),
    ).toBeTruthy();
    expect(
      OrgSearchResponseSchema.safeParse({
        orgs: [{ ...org, coordinator_count: 3, pending_count: 1 }],
        next_cursor: null,
      }).success,
    ).toBe(false);
  });

  it('org parent update takes only a parent id', () => {
    const parent = '00000000-0000-4000-8000-000000000001';
    expect(OrgParentUpdateRequestSchema.parse({ parent_id: parent })).toEqual({
      parent_id: parent,
    });
    for (const bad of [
      {},
      { known_as: 'district' },
      { parent_id: 'not-a-uuid' },
      { parent_id: parent, known_as: 'district' },
      { parent_id: parent, name: 'x' },
    ]) {
      expect(OrgParentUpdateRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('parses the parent options response', () => {
    const option = {
      id: 'p1',
      name: 'Parent',
      depth: 1,
      known_as_name: 'Aggregator',
      ok: true,
      reason: null,
    };
    expect(
      OrgParentOptionsResponseSchema.parse({
        subtree_size: 3,
        options: [option, { ...option, known_as_name: null, ok: false, reason: 'CHILD_LIMIT' }],
      }),
    ).toBeTruthy();
    expect(OrgParentOptionsResponseSchema.parse({ subtree_size: 1, options: [] })).toBeTruthy();
    expect(OrgParentOptionsResponseSchema.safeParse({ options: [] }).success).toBe(false);
    expect(
      OrgParentOptionsResponseSchema.safeParse({
        subtree_size: 1,
        options: [{ ...option, depth: 1.5 }],
      }).success,
    ).toBe(false);
  });

  it('org metadata update requires at least one field (the refine branch)', () => {
    expect(OrgMetadataUpdateRequestSchema.parse({ name: 'New Name' })).toBeTruthy();
    expect(OrgMetadataUpdateRequestSchema.parse({ legal_name: null })).toBeTruthy();
    const empty = OrgMetadataUpdateRequestSchema.safeParse({});
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.issues[0].message).toMatch(/at least one field/);
    }
    expect(OrgMetadataUpdateRequestSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('org metadata update refuses known_as and a parent id', () => {
    const parent = '00000000-0000-4000-8000-000000000001';
    for (const bad of [{ known_as: 'district' }, { parent_id: parent }]) {
      expect(OrgMetadataUpdateRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('parses the hierarchy response', () => {
    const body = {
      network: {
        id: 'root',
        name: 'Network',
        child_known_as: [{ key: 'state', name: 'State', default: true as const }],
      },
      limits: { max_depth: 3, max_children: null, max_total_orgs: 50 },
      total_orgs: 4,
    };
    expect(OrgHierarchyResponseSchema.parse(body)).toEqual(body);
    expect(
      OrgHierarchyResponseSchema.safeParse({ ...body, network: { id: 'root', name: 'Network' } })
        .success,
    ).toBe(false);
    expect(
      OrgHierarchyResponseSchema.safeParse({ ...body, limits: { max_depth: 3 } }).success,
    ).toBe(false);
    expect(
      OrgHierarchyResponseSchema.safeParse({ network: body.network, levels: [] }).success,
    ).toBe(false);
  });

  it('org metadata update: description and profile', () => {
    expect(OrgMetadataUpdateRequestSchema.parse({ description: '  About us  ' }).description).toBe(
      'About us',
    );
    expect(OrgMetadataUpdateRequestSchema.parse({ description: null }).description).toBeNull();
    expect(
      OrgMetadataUpdateRequestSchema.safeParse({ description: 'x'.repeat(1001) }).success,
    ).toBe(false);
    // Schema fields pass through; the API checks them against the org schema.
    expect(
      OrgMetadataUpdateRequestSchema.parse({
        profile: { website: 'https://x.test', gst_number: null },
      }).profile,
    ).toEqual({ website: 'https://x.test', gst_number: null });
    expect(OrgMetadataUpdateRequestSchema.safeParse({ profile: {} }).success).toBe(false);
    // The fields that moved into the schema are no longer top-level keys.
    for (const key of ['url', 'gst_number', 'domains']) {
      expect(OrgMetadataUpdateRequestSchema.safeParse({ [key]: 'x' }).success).toBe(false);
    }
  });

  it('parses the org decision and owner-access responses', () => {
    expect(
      OrgDecisionResponseSchema.parse({
        id: 'o1',
        status: 'active',
        notified: true,
        owner_access: 'granted',
      }),
    ).toBeTruthy();
    expect(
      OwnerAccessResponseSchema.parse({
        id: 'o1',
        status: 'partial',
        enable: 'ok',
        role: 'failed',
        group: 'skipped',
      }),
    ).toBeTruthy();
    expect(OwnerAccessResponseSchema.safeParse({ id: 'o1', status: 'nope' }).success).toBe(false);
  });
});

describe('known_as list schemas', () => {
  const entry = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    name: key.toUpperCase(),
    ...extra,
  });

  it('exports the limits and the system value', () => {
    expect(KNOWN_AS_NAME_MAX).toBe(60);
    expect(KNOWN_AS_MAX_VALUES).toBe(20);
    expect(SYSTEM_KNOWN_AS).toEqual({ key: 'aggregator', name: 'Aggregator' });
  });

  it('parses one entry and trims its name', () => {
    expect(KnownAsEntrySchema.parse({ key: 'state', name: '  State ' })).toEqual({
      key: 'state',
      name: 'State',
    });
    expect(KnownAsEntrySchema.parse({ key: 'state', name: 'State', default: true })).toEqual({
      key: 'state',
      name: 'State',
      default: true,
    });
  });

  it.each([
    ['a missing key', { name: 'State' }],
    ['a malformed key', { key: 'Bad-Key', name: 'State' }],
    ['a key over 64 characters', { key: 'k'.repeat(65), name: 'State' }],
    ['a blank name', { key: 'state', name: '  ' }],
    ['a name over the limit', { key: 'state', name: 'x'.repeat(KNOWN_AS_NAME_MAX + 1) }],
    ['default false', { key: 'state', name: 'State', default: false }],
  ])('refuses an entry with %s', (_case, bad) => {
    expect(KnownAsEntrySchema.safeParse(bad).success).toBe(false);
  });

  it('request entry takes an optional key and refuses unknown fields', () => {
    expect(KnownAsEntryRequestSchema.parse({ name: 'राज्य' })).toEqual({ name: 'राज्य' });
    expect(KnownAsEntryRequestSchema.parse({ key: 'state', name: 'State' })).toEqual({
      key: 'state',
      name: 'State',
    });
    expect(KnownAsEntryRequestSchema.safeParse({ key: 'Bad-Key', name: 'State' }).success).toBe(
      false,
    );
    expect(KnownAsEntryRequestSchema.safeParse({ name: 'State', depths: [1] }).success).toBe(false);
  });

  it('accepts an empty list, a full list and one default', () => {
    expect(ChildKnownAsSchema.parse([])).toEqual([]);
    const full = Array.from({ length: KNOWN_AS_MAX_VALUES }, (_, i) => entry(`v_${i}`));
    expect(ChildKnownAsSchema.parse(full)).toHaveLength(KNOWN_AS_MAX_VALUES);
    expect(ChildKnownAsSchema.parse([entry('a', { default: true }), entry('b')])).toHaveLength(2);
  });

  it('refuses duplicate keys, two defaults and too many entries', () => {
    const dup = ChildKnownAsSchema.safeParse([entry('a'), entry('a')]);
    expect(dup.success).toBe(false);
    if (!dup.success) {
      expect(dup.error.issues[0]).toMatchObject({
        path: [1, 'key'],
        message: 'known_as keys must be unique',
      });
    }
    const twoDefaults = ChildKnownAsSchema.safeParse([
      entry('a', { default: true }),
      entry('b', { default: true }),
    ]);
    expect(twoDefaults.success).toBe(false);
    if (!twoDefaults.success) {
      expect(twoDefaults.error.issues[0].path).toEqual([1, 'default']);
    }
    const tooMany = Array.from({ length: KNOWN_AS_MAX_VALUES + 1 }, (_, i) => entry(`v_${i}`));
    expect(ChildKnownAsSchema.safeParse(tooMany).success).toBe(false);
  });

  it('refuses repeated names, compared trimmed and case-insensitively', () => {
    const dup = ChildKnownAsSchema.safeParse([
      { key: 'state', name: 'State' },
      { key: 'state_2', name: ' state ' },
    ]);
    expect(dup.success).toBe(false);
    if (!dup.success) {
      expect(dup.error.issues[0]).toMatchObject({
        path: [1, 'name'],
        message: 'known_as names must be unique',
      });
    }
    expect(
      ChildKnownAsRequestSchema.safeParse([{ name: 'District' }, { name: 'DISTRICT' }]).success,
    ).toBe(false);
    expect(
      ChildKnownAsRequestSchema.safeParse([{ key: 'state', name: 'State' }, { name: 'state' }])
        .success,
    ).toBe(false);
    expect(ChildKnownAsRequestSchema.parse([{ name: 'State' }, { name: 'States' }])).toHaveLength(
      2,
    );
  });

  it('request list checks only the keys that are given', () => {
    expect(
      ChildKnownAsRequestSchema.parse([{ name: 'State' }, { name: 'District' }, entry('a')]),
    ).toHaveLength(3);
    expect(ChildKnownAsRequestSchema.safeParse([entry('a'), entry('a')]).success).toBe(false);
    expect(
      ChildKnownAsRequestSchema.safeParse([
        { name: 'A', default: true },
        { name: 'B', default: true },
      ]).success,
    ).toBe(false);
    const tooMany = Array.from({ length: KNOWN_AS_MAX_VALUES + 1 }, (_, i) => ({ name: `V${i}` }));
    expect(ChildKnownAsRequestSchema.safeParse(tooMany).success).toBe(false);
  });

  it('known_as update takes one key', () => {
    expect(OrgKnownAsUpdateRequestSchema.parse({ known_as: 'state' })).toEqual({
      known_as: 'state',
    });
    for (const bad of [{}, { known_as: 'Bad-Key' }, { known_as: 'state', name: 'x' }]) {
      expect(OrgKnownAsUpdateRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('child known_as update takes a values list', () => {
    expect(
      OrgChildKnownAsUpdateRequestSchema.parse({
        values: [{ key: 'state', name: 'State', default: true }, { name: 'District' }],
      }),
    ).toEqual({ values: [{ key: 'state', name: 'State', default: true }, { name: 'District' }] });
    expect(OrgChildKnownAsUpdateRequestSchema.parse({ values: [] })).toEqual({ values: [] });
    for (const bad of [
      {},
      { values: [entry('a'), entry('a')] },
      { values: [], known_as: 'state' },
    ]) {
      expect(OrgChildKnownAsUpdateRequestSchema.safeParse(bad).success).toBe(false);
    }
  });
});
