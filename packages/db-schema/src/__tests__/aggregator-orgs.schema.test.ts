import { describe, it, expect } from 'vitest';
import { aggregatorOrgs, aggregators } from '../schema.js';

describe('aggregator_orgs schema', () => {
  it('declares the org system-of-record columns with snake_case SQL names', () => {
    expect(aggregatorOrgs.id.name).toBe('id');
    expect(aggregatorOrgs.slug.name).toBe('slug');
    expect(aggregatorOrgs.displayName.name).toBe('display_name');
    expect(aggregatorOrgs.state.name).toBe('state');
    expect(aggregatorOrgs.contactId.name).toBe('contact_id');
    expect(aggregatorOrgs.ownerKcSub.name).toBe('owner_kc_sub');
    expect(aggregatorOrgs.kcGroupId.name).toBe('kc_group_id');
    expect(aggregatorOrgs.status.name).toBe('status');
    expect(aggregatorOrgs.createdAt.name).toBe('created_at');
    expect(aggregatorOrgs.updatedAt.name).toBe('updated_at');
  });

  it('requires slug, display_name; allows null state; owner lives on contact (no owner_email)', () => {
    expect(aggregatorOrgs.slug.notNull).toBe(true);
    expect(aggregatorOrgs.displayName.notNull).toBe(true);
    expect('ownerEmail' in aggregatorOrgs).toBe(false);
    expect('ownerPhone' in aggregatorOrgs).toBe(false);
    expect(aggregatorOrgs.state.notNull).toBe(false);
  });

  it('adds a nullable parent_org_id FK column to aggregators', () => {
    const col = (aggregators as unknown as Record<string, { name: string; notNull: boolean }>)
      .parentOrgId;
    if (!col) throw new Error('parentOrgId column missing');
    expect(col.name).toBe('parent_org_id');
    expect(col.notNull).toBe(false);
  });
});
