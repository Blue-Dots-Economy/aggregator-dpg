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
  OwnerAccessResponseSchema,
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
      gst_number: null,
      known_as: 'aggregator',
      known_as_label: 'Aggregator',
      level: 1,
      parent_id: 'root',
      parent_name: 'Network',
      created_at: 't',
      updated_at: 't',
    };
    expect(OrgSchema.parse(org)).toBeTruthy();
    expect(OrgSchema.parse({ ...org, known_as: null, known_as_label: null })).toBeTruthy();
    expect(OrgSchema.safeParse({ ...org, known_as: undefined }).success).toBe(false);
    expect(OrgSchema.parse({ ...org, level: null })).toBeTruthy();
    expect(OrgSchema.safeParse({ ...org, level: 1.5 }).success).toBe(false);
    expect(OrgSchema.parse({ ...org, parent_id: null, parent_name: null })).toBeTruthy();
    expect(OrgSchema.safeParse({ ...org, parent_id: undefined }).success).toBe(false);
    expect(
      OrgReadResponseSchema.parse({
        org,
        owner: { id: 'a1', contact },
        coordinator_count: 3,
        pending_count: 1,
      }),
    ).toBeTruthy();
    expect(OrgSearchRequestSchema.parse({ filter: { name_prefix: 'or' } })).toBeTruthy();
    expect(OrgSearchRequestSchema.parse({}).filter).toEqual({});
    expect(OrgSearchRequestSchema.parse({ filter: { known_as: 'training_partner' } })).toBeTruthy();
    expect(OrgSearchRequestSchema.safeParse({ filter: { known_as: 'Bad-Key' } }).success).toBe(
      false,
    );
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
        orgs: [{ ...org, coordinator_count: 3, pending_count: 1 }],
        next_cursor: null,
      }),
    ).toBeTruthy();
  });

  it('org metadata update requires at least one field (the refine branch)', () => {
    expect(OrgMetadataUpdateRequestSchema.parse({ name: 'New Name' })).toBeTruthy();
    expect(
      OrgMetadataUpdateRequestSchema.parse({ url: 'https://x.test', legal_name: null }),
    ).toBeTruthy();
    const empty = OrgMetadataUpdateRequestSchema.safeParse({});
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.issues[0].message).toMatch(/at least one field/);
    }
    expect(OrgMetadataUpdateRequestSchema.safeParse({ url: 'not a url' }).success).toBe(false);
    expect(OrgMetadataUpdateRequestSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('org metadata update accepts a known_as key and a parent id', () => {
    const parent = '00000000-0000-4000-8000-000000000001';
    expect(
      OrgMetadataUpdateRequestSchema.parse({ known_as: 'district', parent_id: parent }),
    ).toEqual({ known_as: 'district', parent_id: parent });
    for (const bad of [{ known_as: 'Bad-Key' }, { parent_id: 'not-a-uuid' }]) {
      expect(OrgMetadataUpdateRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('parses the hierarchy response', () => {
    expect(
      OrgHierarchyResponseSchema.parse({
        network: { id: 'root', name: 'Network' },
        levels: [{ level: 1, values: [{ key: 'state', label: 'State', org_count: 2 }] }],
      }),
    ).toBeTruthy();
    expect(OrgHierarchyResponseSchema.safeParse({ levels: [] }).success).toBe(false);
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
