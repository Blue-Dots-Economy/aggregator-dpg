/**
 * Unit tests for {@link consentSubjectsOf} (`@aggregator-dpg/api`): which
 * consent subjects and audience the terms check reads for an actor.
 */
import { describe, expect, it } from 'vitest';
import { consentSubjectsOf } from '../consent-status.js';
import { buildAdminActor, buildCoordinatorActor } from '../auth/actor/index.js';

const ROOT = '00000000-0000-4000-8000-000000000001';
const DEFAULT_ORG = '00000000-0000-4000-8000-000000000002';
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';

describe('consentSubjectsOf', () => {
  it('reads a coordinator as one user subject under the aggregator audience', () => {
    const actor = buildCoordinatorActor();
    expect(consentSubjectsOf(actor)).toEqual({
      audience: 'aggregator',
      subjects: [{ subjectType: 'user', subjectId: actor.userId }],
    });
  });

  it('reads an owner as one organisation subject per owned aggregator org, skipping root and Default', () => {
    const actor = buildAdminActor({
      orgs: [
        { id: ROOT, orgType: 'network_facilitator', relation: 'owner', isDefault: false },
        { id: DEFAULT_ORG, orgType: 'aggregator', relation: 'owner', isDefault: true },
        { id: ORG_A, orgType: 'aggregator', relation: 'owner', isDefault: false },
        { id: ORG_B, orgType: 'aggregator', relation: 'owner', isDefault: false },
      ],
    });
    expect(consentSubjectsOf(actor)).toEqual({
      audience: 'org',
      subjects: [
        { subjectType: 'organisation', subjectId: ORG_A },
        { subjectType: 'organisation', subjectId: ORG_B },
      ],
    });
  });

  it('gives an owner of only the root no subjects', () => {
    const actor = buildAdminActor({
      orgs: [{ id: ROOT, orgType: 'network_facilitator', relation: 'owner', isDefault: false }],
    });
    expect(consentSubjectsOf(actor)).toEqual({ audience: 'org', subjects: [] });
  });
});
