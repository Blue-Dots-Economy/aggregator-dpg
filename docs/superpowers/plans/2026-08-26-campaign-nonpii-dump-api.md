# Non-PII Dump Download API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /v1/campaign/dump`, a system-authenticated endpoint that returns short-lived pre-signed URLs for the three Signals non-PII snapshot objects, so the external campaign manager can stop holding S3 IAM credentials.

**Architecture:** A new auth helper (`requireCampaignSystemAuth`) gates the route on the `campaign-manager` client's *service-account* token, identified positively by `preferred_username`. The route resolves a fixed key root from config, HEADs the three known object keys, presigns each, and responds. It never streams data and never reads a manifest — the exporter writes fixed keys with no manifest, so per-file `last_modified` is the freshness contract. A mirrored check on `requireCampaignAuth` closes the reverse direction, so a system token cannot reach the org-scoped PII routes.

**Tech Stack:** TypeScript, Fastify, Zod, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, Vitest, pnpm + Turbo monorepo, Keycloak (JWKS verification via `jose`).

**Spec:** `docs/superpowers/specs/2026-08-26-campaign-nonpii-dump-api-design.md`

## Global Constraints

- **Base branch:** `feature`. This plan's work continues on `spec/692-campaign-dump-api`, already cut from `origin/feature`.
- **Package manager:** `pnpm` only. Run API tests with `pnpm --filter @aggregator-dpg/api test -- <path>`.
- **Never bypass hooks:** no `git commit --no-verify` (per `CONTRIBUTING.md`). Conventional Commits required.
- **Commit messages state WHAT changed** — never "review fixes" or "address findings".
- **PRs open as draft.** The user marks them ready.
- **Do not commit or push to `feature` / `develop`.** Do not push at all without explicit confirmation.
- **TSDoc on every exported function**, first line a single sentence ending with a period, with `@param` / `@returns` / `@throws` (`.claude/rules/code-documentation.md`).
- **Module-level file comment** on every new file, stating the module's role and `@module`.
- **Structured logging only** via the app logger — no `console.log`. Required fields: `operation`, `status`, and `latency_ms` on external calls (`.claude/rules/logging-observability.md`).
- **No hardcoded deployment-varying values** (`.claude/rules/configuration-discipline.md`). Every new tunable is an env var mirrored into **both** `apps/api/.env.example` **and** `infra/env.template`.
- **Vitest only, ≥70% line coverage** on touched packages (`.claude/rules/testing-requirements.md`).
- **Exact config values** (copy verbatim):
  - `CAMPAIGN_DUMP_SERVICE_ACCOUNT` default `service-account-campaign-manager`
  - `CAMPAIGN_DUMP_URL_TTL_SECONDS` default `600`
  - `CAMPAIGN_DUMP_PREFIX` default empty (optional)
  - `CAMPAIGN_DUMP_INSTANCE_ID` optional, no default
- **Table order is fixed and exact:** `user`, `items`, `item_actions`.
- **Object key shape:** `[<prefix>/]<network>/<instance_id>/<table>.ndjson.gz`, network from `getNetworkConfig().network.id`.
- **Out of scope for this plan** (spec records them as cross-repo or separate): the bluedots-automation cron repoint, the deployed realm's service account, the S3 IAM revocation, the EkStep client change, and the `aggregator-maintenance.ts:145` bug fix.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/auth/access-token.ts` *(modify)* | Add an `allowedAzp` option to `authenticateAny`; surface `preferredUsername` on `AnyAuthContext`. |
| `apps/api/src/campaign/auth.ts` *(modify)* | Add `requireCampaignSystemAuth`; add the inverted service-account rejection to `requireCampaignAuth`. |
| `apps/api/src/campaign/__tests__/auth.test.ts` *(create)* | Unit tests for both helpers, including the full auth matrix and the fail-closed config guard. |
| `apps/api/src/config.ts` *(modify)* | Four new env vars + a `campaignDumpServiceAccount()` call-time helper. |
| `apps/api/src/errors/codes.ts` *(modify)* | Three new catalogue rows. |
| `apps/api/src/services/object-storage/index.ts` *(modify)* | Add `lastModified` to `ObjectHead`; add the generic `signDownloadUrl`. |
| `apps/api/src/services/object-storage/dump-keys.ts` *(create)* | Pure key-root/key derivation, unit-testable without S3. |
| `apps/api/src/routes/campaign-dump.ts` *(create)* | The route: auth → keys → HEAD ×3 → presign ×3 → audit log → respond. |
| `apps/api/src/routes/campaign-dump.test.ts` *(create)* | Route tests: auth matrix, 404/503 branches, TTL, no-credential assertion. |
| `apps/api/src/app.ts` *(modify)* | Register the route; extend the `campaign` OpenAPI tag description. |
| `apps/api/.env.example`, `infra/env.template` *(modify)* | Document the four vars with the why-comment. |
| `infra/keycloak/realms/realm.json` *(modify)* | Add the missing `campaign-manager` client. |
| `docs/` *(modify)* | API reference entry beside the export endpoint. |

Key decomposition choice: key derivation lives in its own tiny module (`dump-keys.ts`) rather than inside the route, so the "no fallbacks, wrong config must 404" rule is testable as pure logic with no S3 mock.

---

## Task 1: Config vars and the fail-closed service-account helper

**Files:**
- Modify: `apps/api/src/config.ts` (new fields in `ConfigSchema`; new helper after `campaignManagerAllowedAzp` at `:339-350`)
- Modify: `apps/api/.env.example`
- Modify: `infra/env.template`
- Test: `apps/api/src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `config.CAMPAIGN_DUMP_URL_TTL_SECONDS: number`
  - `config.CAMPAIGN_DUMP_PREFIX: string`
  - `config.CAMPAIGN_DUMP_INSTANCE_ID: string | undefined`
  - `campaignDumpServiceAccount(): string`

Read-at-call-time is deliberate for `campaignDumpServiceAccount()` — it mirrors `campaignManagerAllowedAzp()`, which exists in that form so tests in one Vitest worker can vary it after `config` was frozen at first import.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/__tests__/config.test.ts`:

```typescript
describe('campaignDumpServiceAccount', () => {
  const original = process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT;
  afterEach(() => {
    if (original === undefined) delete process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT;
    else process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT = original;
  });

  it('defaults to the campaign-manager service account', () => {
    delete process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT;
    expect(campaignDumpServiceAccount()).toBe('service-account-campaign-manager');
  });

  it('honours an explicit override', () => {
    process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT = 'service-account-other';
    expect(campaignDumpServiceAccount()).toBe('service-account-other');
  });

  it('falls back to the default on an empty value rather than disabling the gate', () => {
    process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT = '';
    expect(campaignDumpServiceAccount()).toBe('service-account-campaign-manager');
  });

  it('falls back to the default on a whitespace-only value', () => {
    process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT = '   ';
    expect(campaignDumpServiceAccount()).toBe('service-account-campaign-manager');
  });
});
```

Add `campaignDumpServiceAccount` to that file's existing import from `../config.js`, and `afterEach` to its `vitest` import if absent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @aggregator-dpg/api test -- src/__tests__/config.test.ts`
Expected: FAIL — `campaignDumpServiceAccount is not a function` (or an import error).

- [ ] **Step 3: Add the schema fields**

In `apps/api/src/config.ts`, inside `ConfigSchema` immediately after `CAMPAIGN_EXPORT_ATTEMPTS` (near `:164`):

```typescript
  /**
   * Non-PII dump download API (#692). The Signals `signals-s3-export` cron
   * writes three fixed keys — `[<prefix>/]<network>/<instance_id>/<table>.ndjson.gz`
   * — into this deployment's own S3 bucket (`S3_BUCKET`); there is no manifest
   * and no dated run folder, so the key root must be configured, never probed.
   * A wrong value must 404, not silently serve a different dataset.
   */
  CAMPAIGN_DUMP_PREFIX: z.string().default(''),
  /**
   * The Signals instance whose dump this deployment serves. One aggregator
   * deployment serves exactly one Signals instance, so this needs no request
   * parameter — but it has no default, and the route returns 503
   * DUMP_NOT_CONFIGURED when it is unset rather than failing the whole API to
   * boot on deployments that do not use the campaign manager.
   */
  CAMPAIGN_DUMP_INSTANCE_ID: z.string().optional(),
  /**
   * Lifetime of the pre-signed dump URLs. The caller is a machine that
   * downloads immediately, so this is far shorter than a human-facing link.
   */
  CAMPAIGN_DUMP_URL_TTL_SECONDS: z.coerce.number().int().positive().default(600),
```

- [ ] **Step 4: Add the helper**

In `apps/api/src/config.ts`, directly after `campaignManagerAllowedAzp` (which ends at `:350`):

```typescript
/**
 * Keycloak `preferred_username` that identifies the campaign-manager system
 * caller on the non-PII dump route (#692).
 *
 * The dump endpoint is whole-network and has no org scoping, so the calling
 * identity is its only control. The `campaign-manager` client serves two
 * identities — a coordinator via the password grant and the system caller via
 * client_credentials — which share one `azp`, so `azp` alone cannot separate
 * them. `preferred_username` can: Keycloak sets it to
 * `service-account-<client-id>` for the service account, and realm usernames
 * are unique, so no human can hold that value.
 *
 * Read from the live environment at **call time**, mirroring
 * {@link campaignManagerAllowedAzp}: it must be independently settable across
 * test cases in one Vitest worker, where the frozen `config` snapshot cannot
 * change after first import.
 *
 * @returns The expected service-account username; the default when the env var
 *   is unset, empty, or whitespace-only.
 */
export function campaignDumpServiceAccount(): string {
  // An empty value must not disable the gate — unlike an allow-list there is no
  // "off" state to fall into, but an empty expected username would match a
  // token with no `preferred_username` claim at all. Fall back to the default.
  return process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT?.trim() || 'service-account-campaign-manager';
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @aggregator-dpg/api test -- src/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Document the vars in both env files**

Append to `apps/api/.env.example` and to `infra/env.template` (both files — the existing campaign vars there set this standard):

```bash
# ── campaign-manager: non-PII dump download API (#692) ──────
# GET /v1/campaign/dump hands the campaign manager pre-signed URLs for the
# Signals non-PII snapshot, so it no longer needs S3 IAM credentials of its own.
#
# The route is WHOLE-NETWORK: unlike /v1/campaign/{export,email,voice} it is not
# scoped to an org, because the campaign manager's own system calls it and needs
# every aggregator's rows. The calling identity is therefore the ONLY control.
# It reuses CAMPAIGN_MANAGER_ALLOWED_AZP above (same Keycloak client) and then
# additionally requires the token's preferred_username to match the value below,
# which is what separates the client_credentials system token from a
# coordinator's password-grant token on that same client. An empty value falls
# back to the default rather than disabling the check.
CAMPAIGN_DUMP_SERVICE_ACCOUNT=service-account-campaign-manager
# The `signals-s3-export` cron writes three fixed keys into THIS deployment's
# bucket (S3_BUCKET above): [<prefix>/]<network>/<instance_id>/<table>.ndjson.gz
# There is no manifest and no dated run folder, so the key root is configured
# here and never probed — a wrong value 404s rather than serving another dataset.
# <network> comes from aggregator.config.yaml, not from env, so it cannot drift.
# Leave the prefix empty if the cron writes keys starting at <network>/.
CAMPAIGN_DUMP_PREFIX=
# Required for the route to work; unset ⇒ 503 DUMP_NOT_CONFIGURED. One aggregator
# deployment serves exactly one Signals instance, e.g. blue_dot_up.
CAMPAIGN_DUMP_INSTANCE_ID=
# Pre-signed URL lifetime. The caller is a machine that downloads immediately.
CAMPAIGN_DUMP_URL_TTL_SECONDS=600
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @aggregator-dpg/api typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/__tests__/config.test.ts \
        apps/api/.env.example infra/env.template
git commit -m "feat(api): add non-PII dump config and the service-account username helper

CAMPAIGN_DUMP_{PREFIX,INSTANCE_ID,URL_TTL_SECONDS} plus
campaignDumpServiceAccount(), which resolves the preferred_username that
identifies the campaign-manager system caller and falls back to the default on
an empty or whitespace-only value so the gate cannot be switched off by config."
```

---

## Task 2: Error catalogue rows

**Files:**
- Modify: `apps/api/src/errors/codes.ts`
- Test: `apps/api/src/errors/__tests__/` (extend the existing catalogue test if one asserts shape across all rows; otherwise no new test — Task 5 covers these through the route)

**Interfaces:**
- Consumes: nothing.
- Produces: `ERR.DUMP_NOT_AVAILABLE` (404), `ERR.DUMP_NOT_CONFIGURED` (503), `ERR.DUMP_STORAGE_UNAVAILABLE` (503), each usable as `httpError('DUMP_NOT_AVAILABLE', …)`.

- [ ] **Step 1: Add the rows**

In `apps/api/src/errors/codes.ts`, after `CAMPAIGN_JOB_NOT_FOUND`:

```typescript
  DUMP_NOT_AVAILABLE: {
    code: 'DUMP_NOT_AVAILABLE',
    status: 404,
    title: 'Dump not available',
    detail: 'The non-PII dump has not been published yet. Please retry later.',
    hint: 'One or more of the three expected objects is missing under the configured key root. Either the signals-s3-export cron has not run in this environment yet, or CAMPAIGN_DUMP_PREFIX / CAMPAIGN_DUMP_INSTANCE_ID does not match what it writes. See response.error.fields.missing for the absent keys.',
  },
  DUMP_NOT_CONFIGURED: {
    code: 'DUMP_NOT_CONFIGURED',
    status: 503,
    title: 'Dump download not configured',
    detail: 'The non-PII dump download is not configured on this deployment.',
    hint: 'CAMPAIGN_DUMP_INSTANCE_ID is unset, so the key root cannot be resolved. Set it to the Signals instance this deployment serves (e.g. blue_dot_up).',
  },
  DUMP_STORAGE_UNAVAILABLE: {
    code: 'DUMP_STORAGE_UNAVAILABLE',
    status: 503,
    title: 'Storage unavailable',
    detail: 'The dump could not be read from storage. Please retry shortly.',
    hint: 'An S3 HEAD or presign call failed on a transport error (not a missing object — those return 404 DUMP_NOT_AVAILABLE). Check S3_ENDPOINT / S3_PUBLIC_ENDPOINT, credentials, and bucket reachability.',
  },
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @aggregator-dpg/api typecheck`
Expected: no errors.

- [ ] **Step 3: Run the error-module tests**

Run: `pnpm --filter @aggregator-dpg/api test -- src/errors`
Expected: PASS (existing tests unaffected; a catalogue-shape test, if present, now covers three more rows).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/errors/codes.ts
git commit -m "feat(api): add dump-availability, config and storage error codes

DUMP_NOT_AVAILABLE (404) for a missing object under the configured key root,
DUMP_NOT_CONFIGURED (503) for an unset instance id, and
DUMP_STORAGE_UNAVAILABLE (503) for an S3 transport failure. The two 503s are
separate codes because they have separate fixes."
```

---

## Task 3: Auth — `authenticateAny` azp override, `requireCampaignSystemAuth`, and the reverse-direction check

This is the load-bearing task. The auth matrix in its tests **is** the specification.

**Files:**
- Modify: `apps/api/src/services/auth/access-token.ts` (`AnyAuthContext` at `:74-85`; `authenticateAny` at `:~300`)
- Modify: `apps/api/src/campaign/auth.ts`
- Test: `apps/api/src/campaign/__tests__/auth.test.ts` (create)

**Interfaces:**
- Consumes: `campaignDumpServiceAccount()` and `campaignManagerAllowedAzp()` from Task 1 / existing config.
- Produces:
  - `authenticateAny(req: FastifyRequest, opts?: { allowedAzp?: readonly string[] }): Promise<AnyAuthResult>`
  - `AnyAuthContext.preferredUsername?: string`
  - `interface CampaignSystemContext { subject: string; azp: string | undefined; username: string }`
  - `requireCampaignSystemAuth(req: FastifyRequest): Promise<CampaignSystemContext>`
  - `requireCampaignAuth` unchanged in signature; now also 403s a service-account token.

Why not `authenticate()`: it *requires* an `aggregator_id` claim and returns `MISSING_AGGREGATOR_ID` without one, and a correctly-provisioned service account has no such claim. `authenticateAny` handles those tokens but has no azp override — hence the additive option.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/campaign/__tests__/auth.test.ts`:

```typescript
/**
 * Tests for the campaign auth helpers — the org-scoped coordinator gate
 * (`requireCampaignAuth`) and the whole-network system gate
 * (`requireCampaignSystemAuth`).
 *
 * The matrix here is the specification for #692: the dump route has no org
 * scoping, so the calling identity is its only control, and BOTH directions
 * must hold — a coordinator token cannot reach the dump, and a system token
 * cannot reach the org-scoped PII routes.
 *
 * @module apps/api/campaign/__tests__/auth.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { requireCampaignAuth, requireCampaignSystemAuth } from '../auth.js';
import {
  _setAccessTokenVerifier,
  _resetJwks,
} from '../../services/auth/access-token.js';

/** Builds a minimal request carrying the given bearer token value. */
function req(token?: string): FastifyRequest {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as FastifyRequest;
}

const SYSTEM_CLAIMS = {
  sub: 'sa-uuid',
  azp: 'campaign-manager',
  preferred_username: 'service-account-campaign-manager',
};

const COORDINATOR_CLAIMS = {
  sub: 'human-uuid',
  azp: 'campaign-manager',
  preferred_username: 'coordinator@org.example',
  aggregator_id: 'agg-1',
  signalstack_org_id: 'org_5d3b7fa4',
  email: 'coordinator@org.example',
};

/**
 * A service account that has been misprovisioned with org attributes — the
 * state the local realm was found in. It must still be rejected by the
 * org-scoped gate, which is exactly what the absence of `aggregator_id`
 * cannot guarantee.
 */
const MISPROVISIONED_SYSTEM_CLAIMS = {
  ...SYSTEM_CLAIMS,
  aggregator_id: 'agg-1',
  signalstack_org_id: 'org_5d3b7fa4',
};

const PORTAL_SERVICE_CLAIMS = {
  sub: 'bff-uuid',
  azp: 'aggregator-bff',
  preferred_username: 'service-account-aggregator-bff',
};

describe('campaign auth', () => {
  beforeEach(() => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    _setAccessTokenVerifier(async (token) => {
      switch (token) {
        case 'system':
          return SYSTEM_CLAIMS;
        case 'coordinator':
          return COORDINATOR_CLAIMS;
        case 'misprovisioned':
          return MISPROVISIONED_SYSTEM_CLAIMS;
        case 'portal':
          return PORTAL_SERVICE_CLAIMS;
        default:
          throw new Error('invalid token');
      }
    });
  });

  afterEach(() => {
    _setAccessTokenVerifier(null);
    delete process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT;
  });

  describe('requireCampaignSystemAuth', () => {
    it('accepts the campaign-manager service-account token', async () => {
      const ctx = await requireCampaignSystemAuth(req('system'));
      expect(ctx).toEqual({
        subject: 'sa-uuid',
        azp: 'campaign-manager',
        username: 'service-account-campaign-manager',
      });
    });

    it('rejects a coordinator token on the same client with 403', async () => {
      await expect(requireCampaignSystemAuth(req('coordinator'))).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('rejects a portal/BFF service token with 403 — wrong azp', async () => {
      await expect(requireCampaignSystemAuth(req('portal'))).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('rejects a missing token with 401', async () => {
      await expect(requireCampaignSystemAuth(req())).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('rejects an unverifiable token with 401', async () => {
      await expect(requireCampaignSystemAuth(req('garbage'))).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('accepts a service account even when it carries stray org attributes', async () => {
      const ctx = await requireCampaignSystemAuth(req('misprovisioned'));
      expect(ctx.username).toBe('service-account-campaign-manager');
    });

    it('does not disable the gate when the expected username is empty', async () => {
      process.env.CAMPAIGN_DUMP_SERVICE_ACCOUNT = '';
      await expect(requireCampaignSystemAuth(req('coordinator'))).rejects.toMatchObject({
        statusCode: 403,
      });
      const ctx = await requireCampaignSystemAuth(req('system'));
      expect(ctx.username).toBe('service-account-campaign-manager');
    });
  });

  describe('requireCampaignAuth — reverse direction', () => {
    it('accepts a coordinator token', async () => {
      const ctx = await requireCampaignAuth(req('coordinator'));
      expect(ctx.aggregatorId).toBe('agg-1');
      expect(ctx.signalstackOrgId).toBe('org_5d3b7fa4');
    });

    it('rejects the system token with 403', async () => {
      await expect(requireCampaignAuth(req('system'))).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('rejects a misprovisioned service account with 403 even though it has an org id', async () => {
      await expect(requireCampaignAuth(req('misprovisioned'))).rejects.toMatchObject({
        statusCode: 403,
      });
    });
  });
});
```

Note on the last assertion: without the new check this test would *pass* for `system` (no `aggregator_id` ⇒ already 403) but **fail** for `misprovisioned`. That single case is the reason the check exists.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @aggregator-dpg/api test -- src/campaign/__tests__/auth.test.ts`
Expected: FAIL — `requireCampaignSystemAuth` is not exported from `../auth.js`.

- [ ] **Step 3: Extend `AnyAuthContext` and `authenticateAny`**

In `apps/api/src/services/auth/access-token.ts`, add to the `AnyAuthContext` interface (after `clientId`):

```typescript
  /**
   * `preferred_username` claim. Keycloak sets it to `service-account-<client>`
   * for a client's service account and to the user's username for an end user,
   * so it distinguishes a client_credentials token from a password-grant token
   * on the SAME client — which `azp` cannot, and which the `sub` claim cannot
   * either (it is a UUID in both cases).
   */
  preferredUsername?: string;
```

Change the `authenticateAny` signature and its `verifyToken` call:

```typescript
export async function authenticateAny(
  req: FastifyRequest,
  opts?: { allowedAzp?: readonly string[] },
): Promise<AnyAuthResult> {
```

```typescript
    payload = await verifyToken(token, opts?.allowedAzp);
```

And populate the claim where the other optional claims are set:

```typescript
  if (typeof claims.preferred_username === 'string') {
    ctx.preferredUsername = claims.preferred_username;
  }
```

Update the function's TSDoc to record the new option:

```typescript
 * @param opts.allowedAzp - Per-call `azp` allow-list that OVERRIDES the global
 *   `KEYCLOAK_ALLOWED_AZP`. Needed by the campaign dump route, whose client is
 *   deliberately excluded from the global list. Omitted ⇒ prior behaviour.
```

- [ ] **Step 4: Add `requireCampaignSystemAuth` and the reverse check**

In `apps/api/src/campaign/auth.ts`, extend the imports:

```typescript
import { authenticate, authenticateAny, type AuthContext } from '../services/auth/access-token.js';
import { campaignDumpServiceAccount, campaignManagerAllowedAzp } from '../config.js';
```

Add the context type and helper:

```typescript
/** Identity of a verified campaign-manager system caller, for audit logging. */
export interface CampaignSystemContext {
  /** Token `sub` — the service-account user id. */
  subject: string;
  /** Token `azp` — the client that requested the token. */
  azp: string | undefined;
  /** Token `preferred_username` — the matched service-account username. */
  username: string;
}

/**
 * Authenticates the campaign-manager SYSTEM caller for the whole-network
 * non-PII dump route (#692).
 *
 * Unlike {@link requireCampaignAuth} this accepts a token with no
 * `aggregator_id` and no `signalstack_org_id`, because the caller is the
 * campaign manager's own service account rather than a coordinator at an
 * aggregator. That route has no org scoping, so this identity check is its only
 * control, and it is deliberately a POSITIVE match on `preferred_username`
 * rather than an inference from an absent claim: `aggregator_id` is a Keycloak
 * user attribute, so a misprovisioned service account can carry one, and the
 * endpoint's safety must not depend on realm state this repo cannot test.
 *
 * @param req - The inbound request carrying the Bearer token.
 * @returns The verified {@link CampaignSystemContext}.
 * @throws `UNAUTHORIZED` when the token is absent or unverifiable, or
 *   `FORBIDDEN` when its `azp` is not allow-listed or it is not the expected
 *   service account.
 */
export async function requireCampaignSystemAuth(
  req: FastifyRequest,
): Promise<CampaignSystemContext> {
  const result = await authenticateAny(req, { allowedAzp: campaignManagerAllowedAzp() });
  if (!result.ok) {
    // An azp rejection surfaces as INVALID_TOKEN from verifyToken, which is a
    // 403 concern (wrong client) rather than a 401 (bad credential). Split them
    // so a mis-scoped client gets an actionable status.
    const isMissing = result.error.code === 'MISSING_TOKEN';
    const isAzp = !isMissing && result.error.message.includes('is not an allowed client');
    throw httpError(isAzp ? 'FORBIDDEN' : 'UNAUTHORIZED', {
      detail: result.error.message,
      fields: { reason: isAzp ? 'AZP_NOT_ALLOWED' : result.error.code },
    });
  }
  const expected = campaignDumpServiceAccount();
  if (result.context.preferredUsername !== expected) {
    throw httpError('FORBIDDEN', {
      detail: 'this route requires the campaign-manager system (client_credentials) token',
      fields: { reason: 'NOT_SYSTEM_CLIENT' },
    });
  }
  return {
    subject: result.context.subject,
    azp: result.context.authorizedParty,
    username: result.context.preferredUsername,
  };
}
```

Then, inside the existing `requireCampaignAuth`, after `if (result.ok)` resolves successfully, reject a system token before returning. Replace its body's success path with:

```typescript
export async function requireCampaignAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req, { allowedAzp: campaignManagerAllowedAzp() });
  if (!result.ok) {
    const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
    throw httpError(code, { detail: result.error.message, fields: { reason: result.error.code } });
  }
  // Reverse direction of the #692 split: the campaign-manager SYSTEM token
  // shares this client's `azp`, so it must be rejected explicitly here. A
  // correctly-provisioned service account already fails above for want of an
  // `aggregator_id`; this closes the misprovisioned case, where stray user
  // attributes would otherwise let a whole-network credential reach org-scoped
  // PII. Keeps the guarantee in this repo's tests rather than in realm state.
  if (result.context.preferredUsername === campaignDumpServiceAccount()) {
    throw httpError('FORBIDDEN', {
      detail: 'the campaign-manager system token cannot access org-scoped campaign routes',
      fields: { reason: 'SYSTEM_TOKEN_NOT_PERMITTED' },
    });
  }
  return result.context;
}
```

Also extend that function's TSDoc `@throws` line to mention the system-token rejection, and update the module-level comment to note that this file now holds both gates.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @aggregator-dpg/api test -- src/campaign/__tests__/auth.test.ts`
Expected: PASS — all 11 cases.

- [ ] **Step 6: Verify nothing else regressed**

Run: `pnpm --filter @aggregator-dpg/api test -- src/routes/campaign-export.test.ts src/routes/campaign-email.test.ts src/routes/campaign-jobs.test.ts`
Expected: PASS. These use coordinator-shaped claims via `_setAccessTokenVerifier`; if any fails because its fake claims happen to set `preferred_username` to the service-account value, fix the fixture, not the guard.

Run: `pnpm --filter @aggregator-dpg/api test -- src/routes/aggregator-maintenance`
Expected: PASS — `authenticateAny`'s existing caller passes no options and keeps the global allow-list.

- [ ] **Step 7: Typecheck and dep-check**

Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm dep-check`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/auth/access-token.ts apps/api/src/campaign/auth.ts \
        apps/api/src/campaign/__tests__/auth.test.ts
git commit -m "feat(api): gate the campaign system caller on preferred_username

Adds requireCampaignSystemAuth for the whole-network dump route: it accepts a
token with no aggregator_id (a service account has none) but requires the
campaign-manager azp AND an exact preferred_username match, since the
client_credentials and password grants on that client share one azp and sub is
a UUID for both. authenticateAny gains an allowedAzp option and surfaces
preferred_username; both are additive and its existing caller is unchanged.

requireCampaignAuth now rejects that same username, so a system token cannot
reach the org-scoped PII routes even when the service account has been
misprovisioned with org attributes."
```

---

## Task 4: Object storage — `lastModified`, the generic presigner, and key derivation

**Files:**
- Modify: `apps/api/src/services/object-storage/index.ts` (`ObjectHead` at `:109-112`; `headObject` at `:120-136`; new export after `signErrorsCsvDownloadUrl` at `:180`)
- Create: `apps/api/src/services/object-storage/dump-keys.ts`
- Test: `apps/api/src/services/object-storage/__tests__/dump-keys.test.ts` (create)

**Interfaces:**
- Consumes: `config.CAMPAIGN_DUMP_PREFIX`, `config.CAMPAIGN_DUMP_INSTANCE_ID` from Task 1.
- Produces:
  - `ObjectHead.lastModified?: Date`
  - `signDownloadUrl(key: string, opts: { ttlSeconds: number; contentType?: string; contentDisposition?: string }): Promise<SignedDownloadUrl>`
  - `DUMP_TABLES: readonly ['user', 'items', 'item_actions']`
  - `type DumpTable = (typeof DUMP_TABLES)[number]`
  - `dumpKeyRoot(opts: { prefix: string; network: string; instanceId: string }): string`
  - `dumpObjectKeys(opts: { prefix: string; network: string; instanceId: string }): Array<{ table: DumpTable; key: string }>`

- [ ] **Step 1: Write the failing key-derivation tests**

Create `apps/api/src/services/object-storage/__tests__/dump-keys.test.ts`:

```typescript
/**
 * Tests for non-PII dump key derivation. Pure logic, no S3 — the "no fallback,
 * a wrong root must 404 rather than serve something else" rule is enforced by
 * these keys being exactly what the exporter writes and nothing more.
 *
 * @module apps/api/services/object-storage/__tests__/dump-keys.test
 */
import { describe, it, expect } from 'vitest';
import { DUMP_TABLES, dumpKeyRoot, dumpObjectKeys } from '../dump-keys.js';

describe('dumpKeyRoot', () => {
  it('omits an empty prefix so keys start at the network segment', () => {
    expect(dumpKeyRoot({ prefix: '', network: 'blue_dot', instanceId: 'blue_dot_up' })).toBe(
      'blue_dot/blue_dot_up',
    );
  });

  it('includes a configured prefix', () => {
    expect(
      dumpKeyRoot({ prefix: 'signals-dumps', network: 'blue_dot', instanceId: 'blue_dot_up' }),
    ).toBe('signals-dumps/blue_dot/blue_dot_up');
  });

  it('normalises surrounding slashes on the prefix', () => {
    expect(
      dumpKeyRoot({ prefix: '/signals-dumps/', network: 'blue_dot', instanceId: 'blue_dot_up' }),
    ).toBe('signals-dumps/blue_dot/blue_dot_up');
  });
});

describe('dumpObjectKeys', () => {
  it('returns the three tables in the exporter order', () => {
    const keys = dumpObjectKeys({ prefix: '', network: 'blue_dot', instanceId: 'blue_dot_up' });
    expect(keys).toEqual([
      { table: 'user', key: 'blue_dot/blue_dot_up/user.ndjson.gz' },
      { table: 'items', key: 'blue_dot/blue_dot_up/items.ndjson.gz' },
      { table: 'item_actions', key: 'blue_dot/blue_dot_up/item_actions.ndjson.gz' },
    ]);
  });

  it('covers every declared table', () => {
    const keys = dumpObjectKeys({ prefix: '', network: 'n', instanceId: 'i' });
    expect(keys.map((k) => k.table)).toEqual([...DUMP_TABLES]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @aggregator-dpg/api test -- src/services/object-storage/__tests__/dump-keys.test.ts`
Expected: FAIL — cannot resolve `../dump-keys.js`.

- [ ] **Step 3: Create the key module**

Create `apps/api/src/services/object-storage/dump-keys.ts`:

```typescript
/**
 * S3 key derivation for the Signals non-PII dump (#692).
 *
 * The `signals-s3-export` cron writes ONE object per table at a FIXED key,
 * overwriting it in place every run:
 *
 *     [<prefix>/]<network>/<instance_id>/<table>.ndjson.gz
 *
 * There is no manifest and no dated run folder (they were removed upstream in
 * adhoc-scripts commits e153c43/d5e4a2d), so "latest" is not resolved at all —
 * these keys ARE the contract. Derivation is kept here, separate from the S3
 * client, so it is unit-testable without a bucket.
 *
 * @module apps/api/services/object-storage/dump-keys
 */

/** Tables the exporter publishes, in the order the API reports them. */
export const DUMP_TABLES = ['user', 'items', 'item_actions'] as const;

/** One of the three exported tables. */
export type DumpTable = (typeof DUMP_TABLES)[number];

/** Inputs that locate one deployment's dump within the bucket. */
export interface DumpLocation {
  /** Optional containing prefix; empty means keys start at the network segment. */
  prefix: string;
  /** Network id, from the resolved aggregator config — never from env. */
  network: string;
  /** The Signals instance this deployment serves. */
  instanceId: string;
}

/**
 * Builds the key prefix shared by this deployment's three dump objects.
 *
 * @param opts - The dump location.
 * @returns The key root, with no trailing slash.
 */
export function dumpKeyRoot(opts: DumpLocation): string {
  const prefix = opts.prefix.replace(/^\/+|\/+$/g, '');
  return [prefix, opts.network, opts.instanceId].filter((p) => p.length > 0).join('/');
}

/**
 * Builds the full key for every exported table.
 *
 * @param opts - The dump location.
 * @returns One entry per table, in {@link DUMP_TABLES} order.
 */
export function dumpObjectKeys(opts: DumpLocation): Array<{ table: DumpTable; key: string }> {
  const root = dumpKeyRoot(opts);
  return DUMP_TABLES.map((table) => ({ table, key: `${root}/${table}.ndjson.gz` }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @aggregator-dpg/api test -- src/services/object-storage/__tests__/dump-keys.test.ts`
Expected: PASS — 5 cases.

- [ ] **Step 5: Surface `lastModified` on `headObject`**

In `apps/api/src/services/object-storage/index.ts`, extend the interface:

```typescript
export interface ObjectHead {
  etag: string;
  contentLength: number;
  /**
   * S3 `LastModified`. Absent only if S3 omits it. The non-PII dump route
   * reports this per object: the exporter overwrites the three keys in place
   * with no cross-object atomicity, so these timestamps are how a consumer
   * detects that it has caught a run mid-flight.
   */
  lastModified?: Date;
}
```

and in `headObject`'s return, after `contentLength`:

```typescript
      ...(result.LastModified ? { lastModified: result.LastModified } : {}),
```

The spread is required rather than a plain assignment because the package builds under `exactOptionalPropertyTypes`.

- [ ] **Step 6: Add the generic presigner**

Append to `apps/api/src/services/object-storage/index.ts`, after `signErrorsCsvDownloadUrl`:

```typescript
/**
 * Issues a pre-signed GET URL for an arbitrary object key.
 *
 * The generic counterpart to the artefact-specific presigners above: the
 * non-PII dump route (#692) signs keys it derives from config rather than from
 * a stored row, so it needs an explicit TTL and no baked-in content headers.
 * Signed against the PUBLIC endpoint client — the campaign manager is outside
 * the cluster, and a pre-signed URL encodes the host it was signed for.
 *
 * @param key - The S3 object key to grant GET access to.
 * @param opts.ttlSeconds - URL lifetime in seconds.
 * @param opts.contentType - Optional response Content-Type override.
 * @param opts.contentDisposition - Optional response Content-Disposition.
 * @returns The signed URL with its key and ISO 8601 expiry.
 */
export async function signDownloadUrl(
  key: string,
  opts: { ttlSeconds: number; contentType?: string; contentDisposition?: string },
): Promise<SignedDownloadUrl> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
    ...(opts.contentDisposition
      ? { ResponseContentDisposition: opts.contentDisposition }
      : {}),
  });
  const url = await getSignedUrl(getPresignerClient(), command, { expiresIn: opts.ttlSeconds });
  const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000).toISOString();
  return { url, key, expiresAt };
}
```

- [ ] **Step 7: Run the object-storage tests and typecheck**

Run: `pnpm --filter @aggregator-dpg/api test -- src/services/object-storage && pnpm --filter @aggregator-dpg/api typecheck`
Expected: PASS, no type errors. Existing `headObject` callers are unaffected — the new field is optional.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/object-storage/
git commit -m "feat(api): add dump key derivation, object LastModified and a generic presigner

dump-keys.ts derives the three fixed exporter keys
([<prefix>/]<network>/<instance_id>/<table>.ndjson.gz) as pure logic, testable
without a bucket. headObject now surfaces LastModified, which the dump response
reports per file because the exporter overwrites the keys in place with no
cross-object atomicity. signDownloadUrl presigns an arbitrary key with an
explicit TTL, against the public endpoint."
```

---

## Task 5: The route

**Files:**
- Create: `apps/api/src/routes/campaign-dump.ts`
- Create: `apps/api/src/routes/campaign-dump.test.ts`
- Modify: `apps/api/src/app.ts` (import beside `:40-42`; registration beside `:206-208`; tag description at `:158-159`)

**Interfaces:**
- Consumes: `requireCampaignSystemAuth` (Task 3); `DUMP_TABLES`, `dumpObjectKeys`, `headObject`, `signDownloadUrl` (Task 4); the three error codes (Task 2); the config vars (Task 1); `getNetworkConfig` from `../services/network-config.js`.
- Produces: `registerCampaignDumpRoutes(app: FastifyInstance): Promise<void>`.

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/src/routes/campaign-dump.test.ts`:

```typescript
/**
 * Tests for GET /v1/campaign/dump — the whole-network non-PII dump download
 * (#692). Covers the auth matrix in both directions, the all-three-or-404 rule,
 * the two 503 branches, TTL propagation, and the invariant that the response
 * leaks no S3 credential.
 *
 * @module apps/api/routes/campaign-dump.test
 */
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc';
process.env.CAMPAIGN_DUMP_INSTANCE_ID = 'blue_dot_up';
process.env.CAMPAIGN_DUMP_URL_TTL_SECONDS = '600';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';

// S3 is mocked: these tests assert the route's contract, not the SDK.
const { headObjectMock, signDownloadUrlMock } = vi.hoisted(() => ({
  headObjectMock: vi.fn(),
  signDownloadUrlMock: vi.fn(),
}));
vi.mock('../services/object-storage/index.js', () => ({
  headObject: headObjectMock,
  signDownloadUrl: signDownloadUrlMock,
}));

const KEYS = {
  user: 'blue_dot/blue_dot_up/user.ndjson.gz',
  items: 'blue_dot/blue_dot_up/items.ndjson.gz',
  item_actions: 'blue_dot/blue_dot_up/item_actions.ndjson.gz',
};

/** Makes every HEAD succeed with a distinct size and timestamp. */
function allObjectsPresent(): void {
  headObjectMock.mockImplementation(async (key: string) => {
    const sizes: Record<string, number> = {
      [KEYS.user]: 12345,
      [KEYS.items]: 23456,
      [KEYS.item_actions]: 34567,
    };
    const times: Record<string, string> = {
      [KEYS.user]: '2026-08-26T00:30:58.000Z',
      [KEYS.items]: '2026-08-26T00:31:04.000Z',
      [KEYS.item_actions]: '2026-08-26T00:31:12.000Z',
    };
    if (!(key in sizes)) return null;
    return { etag: 'e', contentLength: sizes[key], lastModified: new Date(times[key]) };
  });
}

describe('GET /v1/campaign/dump', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    headObjectMock.mockReset();
    signDownloadUrlMock.mockReset().mockImplementation(async (key: string) => ({
      url: `https://s3.public.example/${key}?X-Amz-Signature=abc`,
      key,
      expiresAt: '2026-08-26T00:46:12.000Z',
    }));
    allObjectsPresent();

    _setNetworkConfig(buildBlueDotConfig());
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    process.env.CAMPAIGN_DUMP_INSTANCE_ID = 'blue_dot_up';
    _setAccessTokenVerifier(async (token) => {
      switch (token) {
        case 'system':
          return {
            sub: 'sa-uuid',
            azp: 'campaign-manager',
            preferred_username: 'service-account-campaign-manager',
          };
        case 'coordinator':
          return {
            sub: 'human-uuid',
            azp: 'campaign-manager',
            preferred_username: 'coordinator@org.example',
            aggregator_id: 'agg-1',
            signalstack_org_id: 'org_5d3b7fa4',
          };
        case 'portal':
          return {
            sub: 'bff-uuid',
            azp: 'aggregator-bff',
            preferred_username: 'service-account-aggregator-bff',
          };
        default:
          throw new Error('invalid token');
      }
    });

    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  /** Issues the request with the given bearer token, or none. */
  function get(token?: string) {
    return app.inject({
      method: 'GET',
      url: '/v1/campaign/dump',
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  }

  it('returns all three files with pre-signed URLs for the system token', async () => {
    const res = await get('system');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.network).toBe('blue_dot');
    expect(body.instance).toBe('blue_dot_up');
    expect(body.files).toHaveLength(3);
    expect(body.files.map((f: { table: string }) => f.table)).toEqual([
      'user',
      'items',
      'item_actions',
    ]);
    expect(body.files[0]).toMatchObject({
      table: 'user',
      key: KEYS.user,
      size_bytes: 12345,
      last_modified: '2026-08-26T00:30:58.000Z',
    });
    for (const file of body.files) {
      expect(file.url).toContain('X-Amz-Signature');
    }
  });

  it('rejects a coordinator token with 403', async () => {
    const res = await get('coordinator');
    expect(res.statusCode).toBe(403);
  });

  it('rejects a portal/BFF service token with 403', async () => {
    const res = await get('portal');
    expect(res.statusCode).toBe(403);
  });

  it('rejects a request with no token with 401', async () => {
    const res = await get();
    expect(res.statusCode).toBe(401);
  });

  it.each(Object.entries(KEYS))(
    'returns 404 DUMP_NOT_AVAILABLE and no partial file list when %s is missing',
    async (_table, missingKey) => {
      allObjectsPresent();
      const previous = headObjectMock.getMockImplementation()!;
      headObjectMock.mockImplementation(async (key: string) =>
        key === missingKey ? null : previous(key),
      );
      const res = await get('system');
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error.code).toBe('DUMP_NOT_AVAILABLE');
      expect(body.error.fields.missing).toEqual([missingKey]);
      expect(body.files).toBeUndefined();
    },
  );

  it('returns 503 DUMP_NOT_CONFIGURED when the instance id is unset', async () => {
    delete process.env.CAMPAIGN_DUMP_INSTANCE_ID;
    const res = await get('system');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('DUMP_NOT_CONFIGURED');
  });

  it('returns 503 DUMP_STORAGE_UNAVAILABLE when a HEAD throws', async () => {
    headObjectMock.mockRejectedValue(new Error('connection reset'));
    const res = await get('system');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('DUMP_STORAGE_UNAVAILABLE');
  });

  it('returns 503 DUMP_STORAGE_UNAVAILABLE when presigning throws', async () => {
    signDownloadUrlMock.mockRejectedValue(new Error('presign failed'));
    const res = await get('system');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('DUMP_STORAGE_UNAVAILABLE');
  });

  it('presigns every key with the configured TTL and reports one shared expiry', async () => {
    const res = await get('system');
    expect(res.statusCode).toBe(200);
    expect(signDownloadUrlMock).toHaveBeenCalledTimes(3);
    for (const call of signDownloadUrlMock.mock.calls) {
      expect(call[1]).toMatchObject({ ttlSeconds: 600 });
    }
    expect(res.json().expires_at).toBe('2026-08-26T00:46:12.000Z');
  });

  it('leaks no S3 credential in the response', async () => {
    process.env.S3_ACCESS_KEY_ID = 'AKIAEXAMPLEKEY';
    process.env.S3_SECRET_ACCESS_KEY = 'super-secret-value';
    const res = await get('system');
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('AKIAEXAMPLEKEY');
    expect(res.payload).not.toContain('super-secret-value');
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @aggregator-dpg/api test -- src/routes/campaign-dump.test.ts`
Expected: FAIL — every case 404s, because the route is not registered yet.

- [ ] **Step 3: Write the route**

Create `apps/api/src/routes/campaign-dump.ts`:

```typescript
/**
 * Campaign-manager non-PII dump download (aggregator-dpg#692).
 *
 *   GET /v1/campaign/dump → 200 { network, instance, expires_at, files[] }
 *
 * Hands the campaign manager short-lived pre-signed URLs for the three objects
 * the Signals `signals-s3-export` cron publishes, so that system no longer
 * needs S3 IAM credentials of its own. The route is an authorisation gate: it
 * never streams the data through the aggregator.
 *
 * This is the ONE campaign route with no org scoping — the caller is the
 * campaign manager's own service account, not a coordinator, and it needs every
 * aggregator's rows. The identity check in `requireCampaignSystemAuth` is
 * therefore the only control, and every call is logged.
 *
 * The exporter writes three FIXED keys, overwriting them in place with no
 * manifest and no cross-object atomicity, so there is no run to resolve and no
 * "latest" to look up. The per-file `last_modified` values are the freshness
 * contract: a caller that lands mid-run sees them disagree and decides what to
 * do. Belongs to `@aggregator-dpg/api`.
 *
 * @module apps/api/routes/campaign-dump
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCampaignSystemAuth } from '../campaign/auth.js';
import { getNetworkConfig } from '../services/network-config.js';
import { dumpObjectKeys } from '../services/object-storage/dump-keys.js';
import { headObject, signDownloadUrl } from '../services/object-storage/index.js';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { logger } from '../logger.js';

const dumpFileSchema = z.object({
  table: z.string(),
  key: z.string(),
  size_bytes: z.number().int().nonnegative(),
  last_modified: z.string().nullable(),
  url: z.string(),
});

const dumpResponseSchema = z.object({
  network: z.string(),
  instance: z.string(),
  expires_at: z.string(),
  files: z.array(dumpFileSchema),
});

/**
 * Registers the campaign non-PII dump route.
 *
 * @param app - The Fastify instance to attach the route to.
 */
export async function registerCampaignDumpRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/campaign/dump',
    {
      schema: {
        tags: ['campaign'],
        summary: 'Download the latest non-PII Signals dump',
        description:
          'Returns a short-lived pre-signed URL for each of the three objects in the latest non-PII Signals snapshot (user, items, item_actions), so the caller needs no S3 credentials. Requires the campaign-manager SYSTEM token (client_credentials grant); a coordinator token is rejected. Whole-network and not org-scoped. The exporter overwrites the three objects in place with no cross-object atomicity, so each file carries its own last_modified: a caller that lands mid-run will see them disagree and should retry. Returns all three files or an error, never a partial list.',
        security: [{ bearerAuth: [] }],
        response: {
          200: dumpResponseSchema,
          ...errorResponses(401, 403, 404, 503),
        },
      },
    },
    async (req, reply) => {
      const started = Date.now();
      const auth = await requireCampaignSystemAuth(req);

      const instanceId = config.CAMPAIGN_DUMP_INSTANCE_ID;
      if (!instanceId) {
        throw httpError('DUMP_NOT_CONFIGURED', {
          fields: { reason: 'CAMPAIGN_DUMP_INSTANCE_ID_UNSET' },
        });
      }

      const network = (await getNetworkConfig()).network.id;
      const keys = dumpObjectKeys({
        prefix: config.CAMPAIGN_DUMP_PREFIX,
        network,
        instanceId,
      });

      // HEAD every object before signing anything: the response is
      // all-three-or-nothing, because a short `files` array would read as
      // success and the caller would silently import an incomplete snapshot.
      let heads;
      try {
        heads = await Promise.all(keys.map(async (k) => ({ ...k, head: await headObject(k.key) })));
      } catch (cause) {
        throw storageUnavailable('headObject', cause, auth.subject, started);
      }

      const missing = heads.filter((h) => h.head === null).map((h) => h.key);
      if (missing.length > 0) {
        logger.warn(
          {
            operation: 'campaignDump.serve',
            status: 'failure',
            reason: 'objects_missing',
            azp: auth.azp,
            subject: auth.subject,
            missing,
            latency_ms: Date.now() - started,
          },
          'non-PII dump objects absent under the configured key root',
        );
        throw httpError('DUMP_NOT_AVAILABLE', { fields: { missing } });
      }

      const ttlSeconds = config.CAMPAIGN_DUMP_URL_TTL_SECONDS;
      let signed;
      try {
        signed = await Promise.all(
          heads.map(async (h) => ({
            ...h,
            url: await signDownloadUrl(h.key, { ttlSeconds }),
          })),
        );
      } catch (cause) {
        throw storageUnavailable('signDownloadUrl', cause, auth.subject, started);
      }

      const files = signed.map((s) => ({
        table: s.table,
        key: s.key,
        size_bytes: s.head?.contentLength ?? 0,
        last_modified: s.head?.lastModified?.toISOString() ?? null,
        url: s.url.url,
      }));

      // The only trail this whole-network, un-org-scoped, un-rate-limited read
      // leaves. Becomes an audit-log entry when #617 lands.
      logger.info(
        {
          operation: 'campaignDump.serve',
          status: 'success',
          azp: auth.azp,
          subject: auth.subject,
          username: auth.username,
          network,
          instance: instanceId,
          ttl_seconds: ttlSeconds,
          files: files.map((f) => ({ key: f.key, last_modified: f.last_modified })),
          request_id: req.id,
          latency_ms: Date.now() - started,
        },
        'non-PII dump download URLs issued',
      );

      return reply.code(200).send({
        network,
        instance: instanceId,
        expires_at: signed[0]!.url.expiresAt,
        files,
      });
    },
  );
}

/**
 * Logs an S3 transport failure and builds the 503 to throw.
 *
 * A missing object is not a transport failure — `headObject` returns `null` for
 * `NotFound`/`NoSuchKey`, which drives the 404 instead.
 *
 * @param subOperation - The storage call that failed.
 * @param cause - The thrown value.
 * @param subject - Calling service-account subject, for the log line.
 * @param started - Request start time in ms, for `latency_ms`.
 * @returns The `DUMP_STORAGE_UNAVAILABLE` http error.
 */
function storageUnavailable(
  subOperation: string,
  cause: unknown,
  subject: string,
  started: number,
): Error {
  const message = cause instanceof Error ? cause.message : 'storage call failed';
  logger.error(
    {
      operation: 'campaignDump.serve',
      status: 'failure',
      sub_operation: subOperation,
      error: message,
      error_type: cause instanceof Error ? cause.constructor.name : typeof cause,
      subject,
      latency_ms: Date.now() - started,
    },
    'non-PII dump storage call failed',
  );
  return httpError('DUMP_STORAGE_UNAVAILABLE', { detail: message });
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/app.ts`, add the import beside the other campaign imports (`:40-42`):

```typescript
import { registerCampaignDumpRoutes } from './routes/campaign-dump.js';
```

Add the registration beside the others (`:206-208`):

```typescript
  await registerCampaignDumpRoutes(app);
```

And widen the OpenAPI tag description (`:158-159`):

```typescript
            name: 'campaign',
            description:
              'Campaign integrations — participant PII export (#579) and the non-PII dump download (#692).',
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @aggregator-dpg/api test -- src/routes/campaign-dump.test.ts`
Expected: PASS — 13 cases (the `it.each` expands to three).

- [ ] **Step 6: Run the whole API suite with coverage**

Run: `pnpm --filter @aggregator-dpg/api test --coverage`
Expected: PASS, coverage ≥70% lines. `campaign-dump.ts` and `dump-keys.ts` should both be well above that.

- [ ] **Step 7: Typecheck, lint, dep-check**

Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm -w lint && pnpm dep-check`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/campaign-dump.ts apps/api/src/routes/campaign-dump.test.ts \
        apps/api/src/app.ts
git commit -m "feat(api): add GET /v1/campaign/dump

Returns a pre-signed URL per object for the latest non-PII Signals snapshot, so
the campaign manager needs no S3 credentials of its own. Requires the
campaign-manager system token; a coordinator token is rejected. HEADs all three
keys before signing any, so the response is all three files or an error and
never a partial list, and reports each file's last_modified because the exporter
overwrites the keys in place with no cross-object atomicity. Logs every call
with the calling client, subject and the objects served — the route is
whole-network with no org scoping, so that line is its only trail."
```

---

## Task 6: Keycloak realm client

**Files:**
- Modify: `infra/keycloak/realms/realm.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a `campaign-manager` client in the local realm, so every campaign route (not just the dump) becomes locally testable without a hand-made client.

Read the existing `aggregator-portal` and `aggregator-api` client entries first and mirror their structure — protocol mappers, default client scopes, and the `__..._SECRET__` placeholder convention that `render-realm.sh` substitutes at boot. Do not invent a new shape.

- [ ] **Step 1: Inspect the existing clients**

Run:

```bash
python3 -c "
import json
d = json.load(open('infra/keycloak/realms/realm.json'))
for c in d['clients']:
    if c['clientId'] in ('aggregator-portal', 'aggregator-api'):
        print(json.dumps(c, indent=2))
"
```

Note the exact key names used for secret placeholders, `defaultClientScopes`, and the `aggregator_id` / `signalstack_org_id` protocol mappers.

- [ ] **Step 2: Add the client**

Add a `campaign-manager` entry to the `clients` array with:

- `"clientId": "campaign-manager"`, `"enabled": true`, `"publicClient": false`
- `"serviceAccountsEnabled": true` — the `client_credentials` grant, the system caller
- `"directAccessGrantsEnabled": true` — the `password` grant, coordinators
- `"standardFlowEnabled": false` — this client is not used for a browser login
- `"secret": "__CAMPAIGN_MANAGER_SECRET__"`, following the placeholder convention observed in Step 1
- `defaultClientScopes` **including `profile`** — `preferred_username` comes from there and the dump gate depends on it. Add a comment in the PR description, not the JSON (JSON has no comments).
- the same `aggregator_id` / `signalstack_org_id` / `aggregator_type` user-attribute protocol mappers `aggregator-portal` carries, so a coordinator's password-grant token is shaped like a portal token

Do **not** add user attributes to the service account. A service account with org attributes is precisely the misprovisioning this work guards against.

- [ ] **Step 3: Validate the JSON**

Run:

```bash
python3 -c "
import json
d = json.load(open('infra/keycloak/realms/realm.json'))
c = next(x for x in d['clients'] if x['clientId'] == 'campaign-manager')
assert c['serviceAccountsEnabled'] is True, 'service accounts must be on'
assert c['directAccessGrantsEnabled'] is True, 'direct access grants must be on'
assert 'profile' in c['defaultClientScopes'], 'profile scope is required for preferred_username'
print('ok:', [x['clientId'] for x in d['clients']])
"
```

Expected: `ok: [... 'campaign-manager']` with no assertion error.

- [ ] **Step 4: Check the secret placeholder is wired**

Run: `grep -rn "CAMPAIGN_MANAGER_SECRET\|__AGGREGATOR_API_SECRET__" infra/keycloak/render-realm.sh`

If `render-realm.sh` substitutes each placeholder explicitly rather than generically, add the new one there too, sourced from a `CAMPAIGN_MANAGER_CLIENT_SECRET` env var, and fail hard when unset — matching how the existing three behave. Mirror the new var into `apps/api/.env.example` and `infra/env.template`.

- [ ] **Step 5: Commit**

```bash
git add infra/keycloak/realms/realm.json infra/keycloak/render-realm.sh \
        apps/api/.env.example infra/env.template
git commit -m "feat(keycloak): add the campaign-manager client to the local realm

The realm had no campaign-manager client, so testing any campaign route locally
needed a hand-made one. Adds it with service accounts on (the client_credentials
system caller), direct access grants on (coordinator password grant), standard
flow off, the portal's user-attribute mappers, and the profile scope — which is
where preferred_username comes from, and the dump route's gate depends on it.
The service account deliberately carries no org attributes."
```

Note for the executor: committing this does **not** repair an existing local realm — Keycloak applies a realm import only to an empty realm. An existing local realm still needs the stray `aggregator_id` / `aggregator_type` / `signalstack_org_id` attributes stripped from its `service-account-campaign-manager` user by hand, or a full realm re-import. This must happen before any manual end-to-end test.

---

## Task 7: Docs and OpenAPI

**Files:**
- Modify: the `docs/` API reference file that documents `POST /v1/campaign/export` (locate it in Step 1)
- Modify: the generated OpenAPI artefact, if the repo commits one

**Interfaces:**
- Consumes: the route from Task 5.
- Produces: no code interface.

- [ ] **Step 1: Locate the export endpoint's reference entry and the OpenAPI generator**

Run:

```bash
grep -rln "v1/campaign/export" docs/
grep -rn "openapi" apps/api/package.json
```

- [ ] **Step 2: Write the reference entry**

In the file found in Step 1, add a `GET /v1/campaign/dump` section beside the export entry, covering: the purpose (pre-signed URLs so the caller holds no S3 credentials); that it requires the **system** `client_credentials` token on the `campaign-manager` client, not a coordinator login; that it is whole-network and not org-scoped; the response shape with all four top-level fields and the five per-file fields; the four error codes and what each means; that the URLs expire after `CAMPAIGN_DUMP_URL_TTL_SECONDS` and must be fetched promptly rather than cached; and that each file carries its own `last_modified` because the exporter overwrites the three objects in place with no cross-object atomicity — so a caller that lands mid-run sees them disagree and should retry.

Match the surrounding entries' heading depth and formatting. Include a `curl` example obtaining the token via the `client_credentials` grant and calling the endpoint — with a placeholder secret, never a real one.

- [ ] **Step 3: Regenerate the OpenAPI artefact if the repo commits one**

If Step 1 found a generation script (compare with how commit `4ba7d20` regenerated it for the campaign job knobs), run it. Otherwise skip this step.

Run: `pnpm --filter @aggregator-dpg/api <the script found in step 1>`
Expected: the artefact now contains `/v1/campaign/dump`.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs(campaign): document the non-PII dump download endpoint

Covers the system client_credentials token it requires (not a coordinator
login), that it is whole-network rather than org-scoped, the response and error
shapes, the URL TTL, and why each file carries its own last_modified."
```

---

## Task 8: Full verification and the draft PR

**Files:** none modified.

- [ ] **Step 1: Run the whole repo suite**

Run: `pnpm -w build && pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm dep-check`
Expected: all pass. Do not proceed on a failure — fix it and re-run.

- [ ] **Step 2: Confirm the auth matrix actually ran**

Run: `pnpm --filter @aggregator-dpg/api test -- src/campaign/__tests__/auth.test.ts src/routes/campaign-dump.test.ts --reporter=verbose`

Read the output and confirm each of these named cases is listed as passing — this is the spec's acceptance criterion, so verify it by reading, not by assuming:

- accepts the campaign-manager service-account token
- rejects a coordinator token on the same client with 403
- rejects a portal/BFF service token with 403 — wrong azp
- rejects a missing token with 401
- rejects the system token with 403 *(reverse direction)*
- rejects a misprovisioned service account with 403 even though it has an org id
- does not disable the gate when the expected username is empty
- three × returns 404 DUMP_NOT_AVAILABLE and no partial file list
- leaks no S3 credential in the response

- [ ] **Step 3: Confirm the diff is only what this plan intended**

Run: `git diff --stat origin/feature...HEAD`
Expected: only the files in the File Structure table. Anything else is scope creep — remove it.

- [ ] **Step 4: Ask before pushing**

Do **not** push without explicit confirmation from the user. Report what is ready, then ask.

- [ ] **Step 5: Open the PR as a draft, once confirmed**

```bash
git push -u origin spec/692-campaign-dump-api
gh pr create --draft --base feature \
  --title "feat(api): non-PII dump download API for the campaign manager (#692)" \
  --body-file <(cat <<'BODY'
## Summary

Adds `GET /v1/campaign/dump`, which returns a short-lived pre-signed URL for
each of the three objects in the latest non-PII Signals snapshot. The campaign
manager can then drop its own S3 IAM credentials — that revocation, tracked in
bluedots-automation, is the point of the change.

Unlike `/v1/campaign/{export,email,voice}`, this route is **whole-network**: the
campaign manager's own service account calls it and needs every aggregator's
rows, so there is no org scoping and the calling identity is the only control.
The gate is therefore a positive match on the token's `preferred_username`,
which is what separates the `client_credentials` system token from a
coordinator's password-grant token on the same `campaign-manager` client —
`azp` cannot, since they share one, and `sub` cannot, since it is a UUID for
both. The reverse direction is closed too: `requireCampaignAuth` now rejects
that same username, so a system token cannot reach the org-scoped PII routes.

Design: `docs/superpowers/specs/2026-08-26-campaign-nonpii-dump-api-design.md`,
which also records the deliberate deviations from #692 and why. The largest:
the exporter no longer writes `latest_manifest.json` — it overwrites three fixed
keys in place — so there is no run to resolve, no `run_id`, and no cross-object
atomicity. Each file therefore reports its own `last_modified`, and a caller
that lands mid-run sees them disagree and decides what to do.

## In Plain Terms

Twice a day a scheduled job copies a stripped-down, no-personal-information
snapshot of the Signals database into cloud storage. Until now the campaign
manager — a separate system run by another team — reached into that storage
directly using its own keys. Handing long-lived storage keys to an outside
system is what we're getting rid of.

Now it asks us instead. This change adds an endpoint it can call to get three
temporary download links that stop working after ten minutes. It never receives
a storage key, and we can see every time it asks and what it was given.

The security question here is unusual. Our other campaign endpoints are safe
partly because they only ever return data belonging to the caller's own
organisation. This one deliberately returns everything, so that protection
doesn't apply — which means the check on *who is calling* is the only thing
standing in the way. The change makes that check a positive identification of
the campaign manager's automated account, and adds the mirror-image check to
the existing endpoints so that same automated account cannot reach the data
that does contain personal information.

## Release Notes

- New endpoint `GET /v1/campaign/dump` returning pre-signed URLs for the
  non-PII Signals snapshot, gated to the campaign-manager system token.
- New config: `CAMPAIGN_DUMP_SERVICE_ACCOUNT`, `CAMPAIGN_DUMP_PREFIX`,
  `CAMPAIGN_DUMP_INSTANCE_ID`, `CAMPAIGN_DUMP_URL_TTL_SECONDS`.
  `CAMPAIGN_DUMP_INSTANCE_ID` must be set for the route to serve; unset yields
  `503 DUMP_NOT_CONFIGURED`.
- The local Keycloak realm now ships a `campaign-manager` client, so campaign
  routes are testable locally without a hand-made one.

## Follow-ups (not in this PR)

- bluedots-automation: repoint the `signals-s3-export` cron at this bucket,
  provision the deployed service account with no org attributes, and revoke the
  campaign manager's direct S3 IAM access.
- campaign-manager (EkStep): switch to this endpoint using the
  `client_credentials` grant.
- `aggregator-maintenance.ts:145` gates on `subject.startsWith('service-account-')`,
  but `sub` is a UUID for service accounts too, so that check can never pass and
  `/cleanup-stale` is permanently 403. Fails closed, but the scheduler's cleanup
  has never run. Both `apps/api/CLAUDE.md` and the root `CLAUDE.md` describe it
  as working, so the docs need correcting alongside the code. Needs its own issue.
BODY
)
```

- [ ] **Step 6: Report the PR URL and stop**

Leave the PR as a draft. The user marks it ready.

---

## Self-Review

**Spec coverage.** Walked each spec section against the tasks:

| Spec section | Task |
|---|---|
| Auth — `authenticateAny` option, `preferredUsername`, `requireCampaignSystemAuth`, reverse check, fail-closed config | 1, 3 |
| API contract — path, response fields, table order, shared `expires_at` | 5 |
| Errors — three new codes, all-three-or-404 | 2, 5 |
| Configuration — four vars, both env files, network from network-config, no fallbacks | 1 |
| Object storage — `signDownloadUrl`, `lastModified`, no `getObjectText`, leave `signErrorsCsvDownloadUrl` alone | 4 |
| Route — registration, OpenAPI tag, `errorResponses` | 5 |
| Audit — structured line with `operation`/`status`/`latency_ms` + identity + keys | 5 |
| Testing — the full auth matrix, 404 per missing object, both 503s, TTL, no credentials | 3, 5, 8 |
| Keycloak realm — the missing client, `profile` scope, no service-account org attributes | 6 |
| Docs — reference entry, OpenAPI regen | 7 |
| Cross-repo work | Out of scope; carried into the PR's Follow-ups |

No gaps found.

**Placeholders.** No "TBD"/"TODO"/"add error handling"/"similar to Task N". Every code step carries real code. Tasks 6 and 7 begin with an inspect step because the exact shape of `realm.json`'s client entries and the location of the docs file must be read from the repo rather than guessed — the step says exactly what to look for and what to assert afterwards, so it is a discovery instruction, not a placeholder.

**Type consistency.** Checked across tasks: `campaignDumpServiceAccount()` (Task 1) is the name imported in Task 3 and the reverse check. `ObjectHead.lastModified?: Date` (Task 4) is consumed in Task 5 as `s.head?.lastModified?.toISOString() ?? null`, matching the route schema's `z.string().nullable()`. `signDownloadUrl(key, { ttlSeconds })` (Task 4) matches the Task 5 call site and the Task 5 test's `toMatchObject({ ttlSeconds: 600 })`. `dumpObjectKeys` returns `{ table, key }`, which is what Task 5 spreads. `CampaignSystemContext` fields `{ subject, azp, username }` (Task 3) match both the Task 3 assertion and the Task 5 log line. `DUMP_TABLES` order matches the Task 5 test's expected `files` order.
