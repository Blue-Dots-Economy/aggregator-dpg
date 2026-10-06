import { describe, expect, it } from 'vitest';
import { InMemoryAuthorizer } from '../in-memory/index.js';
import { AuthorizerFake, buildActor, buildActorOrg } from '../testing/index.js';
import type { DecisionInput } from '../interface.js';

describe('InMemoryAuthorizer', () => {
  it('allows what the role and the org set both hold', async () => {
    const res = await new InMemoryAuthorizer().decide({
      capability: 'profiles.view',
      actor: buildActor(),
      now: 0,
    });
    expect(res).toEqual({ success: true, value: { allow: true, reasons: [] } });
  });

  it('rejects a malformed input', async () => {
    const res = await new InMemoryAuthorizer().decide({
      capability: 'nope',
      actor: buildActor(),
      now: 0,
    } as unknown as DecisionInput);
    expect(!res.success && res.error.code).toBe('RBAC_INPUT_INVALID');
  });
});

describe('AuthorizerFake', () => {
  it('records inputs and evaluates the real rules', async () => {
    const fake = new AuthorizerFake();
    const actor = buildActor({ orgs: [buildActorOrg({ capabilities: [] })] });
    const res = await fake.decide({ capability: 'profiles.view', actor, now: 0 });
    expect(res.success && res.value).toEqual({ allow: false, reasons: ['not_in_org_set'] });
    expect(fake.calls).toHaveLength(1);
  });

  it('fails every call after failWith', async () => {
    const fake = new AuthorizerFake();
    fake.failWith();
    const res = await fake.decide({ capability: 'profiles.view', actor: buildActor(), now: 0 });
    expect(!res.success && res.error.code).toBe('OPA_UNAVAILABLE');
  });
});
