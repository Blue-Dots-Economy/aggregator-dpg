# Per-Link Submission Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-link `submission_mode` toggle (`account_only` | `account_and_profile`) that the server enforces and the public form renders to match — locking a registration link to identity-only capture or full identity + profile at create time.

**Architecture:** One additive Drizzle column on `registration_links` (default `'account_and_profile'`, fully back-compat). Admin create accepts the field; admin update rejects it via existing `.strict()` schema. Public resolve surfaces the mode; public submit branches handler logic on it. Web form passes the mode as a prop and renders a `MinimalIdentityForm` sub-component when account_only.

**Tech Stack:** Drizzle ORM + Postgres, Fastify, Zod, Next.js App Router, Vitest, TypeScript-only.

---

## Spec ↔ Codebase Reconciliation

| Spec calls it                                          | Actual location                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `POST /admin/v1/registration-links`                    | `POST /v1/links/create` in `apps/api/src/routes/registration-links.ts`          |
| `PATCH /admin/v1/registration-links/:id`               | `PATCH /v1/links/:id` in same file (already `.strict()`)                        |
| `GET /public/v1/aggregators/:org/links/:slug`          | Same path — handler lives in `apps/api/src/routes/public-registration-links.ts` |
| `POST /public/v1/aggregators/:org/registrations/:slug` | Same path — handler in same file                                                |
| `MinimalIdentityForm`                                  | New file `apps/web/src/app/[org]/[slug]/MinimalIdentityForm.tsx`                |

`completion_actions` is not currently exposed on the admin POST body — it defaults to `[]` per the column default. The create-time guard for `account_only + completion_actions` still lands (defensive: column allows direct DB writes; protects against a future admin endpoint that exposes the field).

---

## File Map

**Database:**

- Modify: `packages/db-schema/src/schema.ts` — add `submissionMode` text column to `registrationLinks`
- Create: `apps/api/drizzle/migrations/0014_per_link_submission_mode.sql` — DDL
- Modify: `packages/db-schema/src/__tests__/schema.test.ts` — assert column shape

**Errors:**

- Modify: `apps/api/src/errors/codes.ts` — add `SUBMISSION_MODE_MISMATCH`, `SUBMISSION_MODE_IMMUTABLE`

**API (admin):**

- Modify: `apps/api/src/routes/registration-links.ts` — `CreateLinkBodySchema` gains optional `submission_mode`; create handler validates the `account_only + completion_actions` guard; update handler relies on existing `.strict()` rejection (explicit test added)

**API (public):**

- Modify: `apps/api/src/routes/public-registration-links.ts` — resolve GET surfaces `submission_mode` + null-schema for account_only; submit POST branches on link's mode (account_only validation, forced submit_mode, no dispatcher fan-out)

**API tests:**

- Create: `apps/api/src/routes/__tests__/registration-links.submission-mode.test.ts` — admin create/update mode behaviour
- Create: `apps/api/src/routes/__tests__/public-registration-links.submission-mode.test.ts` — public resolve + submit mode behaviour

**Web:**

- Create: `apps/web/src/app/[org]/[slug]/MinimalIdentityForm.tsx` — identity-only form (Name + Phone + Email + consent)
- Modify: `apps/web/src/app/[org]/[slug]/page.tsx` — extend `ResolveResponse` with `submission_mode`, thread to view
- Modify: `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx` — branch on `submissionMode` prop
- Modify: `apps/web/src/i18n/messages/{en,hi,kn}.json` — three new keys under `Registration.account_only.*`

**Web tests:**

- Create: `apps/web/src/__tests__/views/PublicRegistrationView.submission-mode.test.tsx` — renders minimal form when `account_only`; renders existing form when `account_and_profile`
- Create: `apps/web/src/__tests__/components/MinimalIdentityForm.test.tsx` — identity validation

---

## Task 0: Pre-flight

- [ ] **Step 1: Confirm branch + baseline tests**

```bash
git rev-parse --abbrev-ref HEAD
# expect: feat/account-only-onboarding-mode
pnpm -w test 2>&1 | tail -3
# expect: all packages green
```

---

## Task 1: Add `submission_mode` column to db-schema

**Files:**

- Modify: `packages/db-schema/src/schema.ts` (the `registrationLinks` pgTable definition)
- Modify: `packages/db-schema/src/__tests__/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/db-schema/src/__tests__/schema.test.ts`:

```ts
describe('registrationLinks.submission_mode', () => {
  it('exists on the table', () => {
    const col = (registrationLinks as Record<string, unknown>).submissionMode;
    expect(col).toBeDefined();
  });

  it('is the text column named submission_mode in SQL', () => {
    const col = (registrationLinks as unknown as { submissionMode: { name: string } })
      .submissionMode;
    expect(col.name).toBe('submission_mode');
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm --filter @aggregator-dpg/db-schema test -- schema.test
# expect: FAIL — `submissionMode` is undefined
```

- [ ] **Step 3: Add the column**

In `packages/db-schema/src/schema.ts`, inside the `registrationLinks = pgTable('registration_links', { ... })` block, after `completion_actions` (or wherever the column ordering convention places it — match the prevailing style), add:

```ts
  submissionMode: text('submission_mode')
    .notNull()
    .default('account_and_profile')
    .$type<'account_only' | 'account_and_profile'>(),
```

- [ ] **Step 4: Run test, verify PASS**

```bash
pnpm --filter @aggregator-dpg/db-schema test -- schema.test
# expect: PASS
pnpm --filter @aggregator-dpg/db-schema typecheck
# expect: clean
```

- [ ] **Step 5: Commit**

```bash
git add packages/db-schema/src/schema.ts packages/db-schema/src/__tests__/schema.test.ts
git commit -m "feat(db-schema): add registration_links.submission_mode column"
```

---

## Task 2: SQL migration for the column

**Files:**

- Create: `apps/api/drizzle/migrations/0014_per_link_submission_mode.sql`
- Modify: `apps/api/drizzle/migrations/meta/_journal.json` (auto-generated)

- [ ] **Step 1: Generate the migration**

```bash
pnpm db:generate:api
# Drizzle emits 0014_<random>.sql and updates _journal.json
```

- [ ] **Step 2: Rename the generated file**

If Drizzle named it something like `0014_misty_doctor_octopus.sql`, rename to `0014_per_link_submission_mode.sql` AND update the matching `tag` in `meta/_journal.json`:

```bash
mv apps/api/drizzle/migrations/0014_*.sql apps/api/drizzle/migrations/0014_per_link_submission_mode.sql
# Then hand-edit meta/_journal.json: change the matching `tag` value to "0014_per_link_submission_mode"
```

- [ ] **Step 3: Verify the SQL is additive**

Open `apps/api/drizzle/migrations/0014_per_link_submission_mode.sql`. It should contain:

```sql
ALTER TABLE "registration_links"
  ADD COLUMN "submission_mode" text DEFAULT 'account_and_profile' NOT NULL;
```

If Drizzle did NOT emit a `CHECK` constraint, append it manually:

```sql
ALTER TABLE "registration_links"
  ADD CONSTRAINT "registration_links_submission_mode_check"
  CHECK ("submission_mode" IN ('account_only', 'account_and_profile'));
```

(Drizzle's `.$type<...>()` is TS-only and does not produce SQL CHECK constraints — manual append is required.)

- [ ] **Step 4: Run migration locally to verify**

```bash
docker compose up -d postgres
pnpm --filter @aggregator-dpg/api db:migrate
# expect: 0014_per_link_submission_mode applied cleanly
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/drizzle/migrations/0014_per_link_submission_mode.sql apps/api/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): migration for registration_links.submission_mode + CHECK"
```

---

## Task 3: Add error codes

**Files:**

- Modify: `apps/api/src/errors/codes.ts`

- [ ] **Step 1: Add the two new codes**

Find the existing error codes map. After the most recent code (likely `SIGNALSTACK_PROBE_FAILED`), add:

```ts
SUBMISSION_MODE_MISMATCH: {
  status: 400,
  title: 'Submission mode mismatch',
  hint: 'The link is account_only — body must not include item_state or profile fields.',
},
SUBMISSION_MODE_IMMUTABLE: {
  status: 400,
  title: 'Submission mode is immutable',
  hint: 'submission_mode cannot be changed after a registration link is created.',
},
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @aggregator-dpg/api typecheck
# expect: clean
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/errors/codes.ts
git commit -m "feat(api): error codes for submission_mode mismatch + immutability"
```

---

## Task 4: Admin create accepts `submission_mode`

**Files:**

- Modify: `apps/api/src/routes/registration-links.ts` (`CreateLinkBodySchema` ≈ line 83 + handler at `app.post('/v1/links/create', ...)` ≈ line 137)
- Create: `apps/api/src/routes/__tests__/registration-links.submission-mode.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/__tests__/registration-links.submission-mode.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../../services/auth/access-token.js';
import { _setNetworkConfig } from '../../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';

const AGG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('POST /v1/links/create — submission_mode', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    _setNetworkConfig(buildBlueDotConfig());
    _setAccessTokenVerifier(async (token) => {
      if (token === 'agg-token') return { sub: 'kc-1', email: 'a@x.com', aggregator_id: AGG };
      throw new Error('invalid');
    });
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  it('defaults submission_mode to account_and_profile when omitted', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: 'Bearer agg-token' },
      payload: { domain: 'seeker' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().submission_mode).toBe('account_and_profile');
  });

  it('accepts submission_mode=account_only', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: 'Bearer agg-token' },
      payload: { domain: 'seeker', submission_mode: 'account_only' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().submission_mode).toBe('account_only');
  });

  it('rejects unknown submission_mode values', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: 'Bearer agg-token' },
      payload: { domain: 'seeker', submission_mode: 'bogus' },
    });
    expect(r.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm --filter @aggregator-dpg/api test -- registration-links.submission-mode
# expect: 3 failures (field not in schema, default not returned, etc.)
```

- [ ] **Step 3: Extend `CreateLinkBodySchema`**

In `apps/api/src/routes/registration-links.ts`, modify `CreateLinkBodySchema`:

```ts
const CreateLinkBodySchema = z.object({
  domain: z.string().min(1),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase + hyphens (a-z, 0-9)')
    .min(3)
    .max(60)
    .optional(),
  context: z.record(z.unknown()).default({}),
  status: z.enum(['draft', 'live']).default('draft'),
  submission_mode: z.enum(['account_only', 'account_and_profile']).default('account_and_profile'),
  expires_at: z
    .string()
    .datetime({ offset: true })
    .nullish()
    .transform((v) => (v ? new Date(v) : null)),
});
```

- [ ] **Step 4: Thread the field through the insert + response**

In the create handler, find the `db.insert(registrationLinks).values({ ... })` call and add:

```ts
  submissionMode: body.submission_mode,
```

In the response object the handler returns, add:

```ts
  submission_mode: row.submissionMode,
```

(Match the existing snake_case → camelCase convention used in this handler for other fields.)

- [ ] **Step 5: Run tests, verify PASS**

```bash
pnpm --filter @aggregator-dpg/api test -- registration-links.submission-mode
# expect: 3 PASS
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/registration-links.ts apps/api/src/routes/__tests__/registration-links.submission-mode.test.ts
git commit -m "feat(api): admin create accepts submission_mode with default + enum"
```

---

## Task 5: Admin PATCH rejects `submission_mode` (immutability)

**Files:**

- Modify: `apps/api/src/routes/__tests__/registration-links.submission-mode.test.ts` (extend)

The `UpdateLinkBodySchema` is already `.strict()`, so unknown keys auto-reject with a Zod parse error → 400 via the existing handler. This task adds a regression test only.

- [ ] **Step 1: Write the failing test**

Append a new `describe` block in `registration-links.submission-mode.test.ts`:

```ts
describe('PATCH /v1/links/:id — submission_mode immutability', () => {
  let app: FastifyInstance;
  let createdId: string;

  beforeEach(async () => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    _setNetworkConfig(buildBlueDotConfig());
    _setAccessTokenVerifier(async (token) => {
      if (token === 'agg-token') return { sub: 'kc-1', email: 'a@x.com', aggregator_id: AGG };
      throw new Error('invalid');
    });
    app = await buildApp();
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: 'Bearer agg-token' },
      payload: { domain: 'seeker', submission_mode: 'account_and_profile' },
    });
    createdId = createRes.json().id;
  });
  afterAll(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  it('rejects submission_mode in PATCH body with 400', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/v1/links/${createdId}`,
      headers: { authorization: 'Bearer agg-token' },
      payload: { submission_mode: 'account_only' },
    });
    expect(r.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test, verify it PASSES out of the box (existing `.strict()` rejects unknown keys)**

```bash
pnpm --filter @aggregator-dpg/api test -- registration-links.submission-mode
# expect: PASS — no code change needed
```

If the test fails (e.g. PATCH returns 200 silently dropping the field), then `UpdateLinkBodySchema` is no longer `.strict()`. Re-confirm by reading the schema definition; if needed, re-apply `.strict()`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/__tests__/registration-links.submission-mode.test.ts
git commit -m "test(api): PATCH /v1/links/:id rejects submission_mode (immutability)"
```

---

## Task 6: Surface `submission_mode` on public resolve

**Files:**

- Modify: `apps/api/src/routes/public-registration-links.ts` (the GET `/public/v1/aggregators/:org/links/:slug` handler)

- [ ] **Step 1: Write the failing test**

Append to (or create) `apps/api/src/routes/__tests__/public-registration-links.submission-mode.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../../services/auth/access-token.js';
import { _setNetworkConfig } from '../../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';

const AGG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('GET /public/v1/aggregators/:org/links/:slug — submission_mode', () => {
  let app: FastifyInstance;
  let accountOnlySlug: string;
  let fullSlug: string;

  beforeEach(async () => {
    _resetJwks();
    _setNetworkConfig(buildBlueDotConfig());
    _setAccessTokenVerifier(async (token) => {
      if (token === 'agg-token') return { sub: 'kc-1', email: 'a@x.com', aggregator_id: AGG };
      throw new Error('invalid');
    });
    app = await buildApp();
    // Seed two links via the admin route.
    const aResp = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: 'Bearer agg-token' },
      payload: { domain: 'seeker', submission_mode: 'account_only', status: 'live' },
    });
    accountOnlySlug = aResp.json().slug;
    const fResp = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: 'Bearer agg-token' },
      payload: { domain: 'seeker', submission_mode: 'account_and_profile', status: 'live' },
    });
    fullSlug = fResp.json().slug;
  });
  afterAll(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setNetworkConfig(null);
  });

  it('surfaces submission_mode and nulls schema when account_only', async () => {
    // The org slug must match the aggregator's org_slug. Adjust if your
    // buildBlueDotConfig fixture uses a different slug — confirm via the
    // existing public-lookup tests in the same directory.
    const r = await app.inject({
      method: 'GET',
      url: `/public/v1/aggregators/acme/links/${accountOnlySlug}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.submission_mode).toBe('account_only');
    expect(body.schema).toBeNull();
  });

  it('surfaces submission_mode and includes schema when account_and_profile', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/public/v1/aggregators/acme/links/${fullSlug}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.submission_mode).toBe('account_and_profile');
    expect(body.schema).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm --filter @aggregator-dpg/api test -- public-registration-links.submission-mode
# expect: FAIL — body.submission_mode is undefined
```

- [ ] **Step 3: Update the resolve handler**

In `apps/api/src/routes/public-registration-links.ts`, find the GET handler that returns the resolve response. Locate the line where `schema` is set (it's loaded from the network config). Update the response object to include the mode and null out `schema` when account_only:

```ts
const submissionMode = link.submissionMode ?? 'account_and_profile';
return reply.send({
  // ... existing fields ...
  submission_mode: submissionMode,
  schema_id: submissionMode === 'account_only' ? null : currentSchemaId,
  schema_version: submissionMode === 'account_only' ? null : currentSchemaVersion,
  schema: submissionMode === 'account_only' ? null : currentSchema,
  identity: link.identity, // unchanged
  expires_at: link.expiresAt,
});
```

(Adjust property names to match the existing handler's variables — read the surrounding code to see what `currentSchemaId` / `currentSchema` are actually called.)

- [ ] **Step 4: Run tests, verify PASS**

```bash
pnpm --filter @aggregator-dpg/api test -- public-registration-links.submission-mode
# expect: PASS on both resolve tests
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/public-registration-links.ts apps/api/src/routes/__tests__/public-registration-links.submission-mode.test.ts
git commit -m "feat(api): public resolve surfaces submission_mode + nulls schema for account_only"
```

---

## Task 7: Public submit branches on `submission_mode`

**Files:**

- Modify: `apps/api/src/routes/public-registration-links.ts` (the POST submit handler)
- Modify: `apps/api/src/routes/__tests__/public-registration-links.submission-mode.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```ts
describe('POST /public/v1/aggregators/:org/registrations/:slug — submission_mode', () => {
  let app: FastifyInstance;
  let accountOnlySlug: string;
  let fullSlug: string;

  // Setup identical to the GET tests above — extract a shared helper if
  // the file gets long.

  it('account_only link: accepts identity-only body, skips dispatcher', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/acme/registrations/${accountOnlySlug}`,
      payload: {
        name: 'A. User',
        phone_number: '+919999999999',
        consent_terms: true,
        consent_privacy: true,
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.lifecycle_status).toBeNull();
    expect(body.completion_pct).toBeNull();
    // Assert no dispatcher rows landed — query outbound_dispatch_log via
    // the in-memory log fake or its CRUD service.
  });

  it('account_only link: rejects body containing item_state with 400 SUBMISSION_MODE_MISMATCH', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/acme/registrations/${accountOnlySlug}`,
      payload: {
        name: 'A. User',
        phone_number: '+919999999999',
        consent_terms: true,
        consent_privacy: true,
        item_state: { profile_field: 'x' },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('SUBMISSION_MODE_MISMATCH');
  });

  it('account_only link: ignores `partial: true` in body (always account_only regardless)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/acme/registrations/${accountOnlySlug}`,
      payload: {
        name: 'A. User',
        email: 'u@example.com',
        consent_terms: true,
        consent_privacy: true,
        partial: true,
      },
    });
    expect(r.statusCode).toBe(201);
  });

  it('account_and_profile link: existing behaviour unchanged (regression)', async () => {
    // Send a regular full-form submission to a legacy/default link.
    // Reuse the existing public-registration-links.lifecycle.test.ts shape.
    const r = await app.inject({
      method: 'POST',
      url: `/public/v1/aggregators/acme/registrations/${fullSlug}`,
      payload: {
        name: 'B. User',
        phone_number: '+919888888888',
        consent_terms: true,
        consent_privacy: true,
        item_state: {
          /* full profile */
        },
      },
    });
    expect([200, 201]).toContain(r.statusCode);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm --filter @aggregator-dpg/api test -- public-registration-links.submission-mode
# expect: account_only tests FAIL — handler does not branch on mode yet
```

- [ ] **Step 3: Add the account_only branch to the submit handler**

In `apps/api/src/routes/public-registration-links.ts`, in the POST submit handler, after the link is loaded from the DB, add an early branch:

```ts
const submissionMode = link.submissionMode ?? 'account_and_profile';

if (submissionMode === 'account_only') {
  // Identity-only validation: name + (phone OR email) + consent. Reject
  // any other field (item_state, partial outside the allowed set, etc.).
  const allowed = new Set([
    'name',
    'phone_number',
    'email',
    'consent_terms',
    'consent_privacy',
    'partial',
  ]);
  for (const key of Object.keys(req.body as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      throw httpError('SUBMISSION_MODE_MISMATCH', {
        detail: `account_only link does not accept field '${key}'`,
      });
    }
  }
  const body = req.body as {
    name?: string;
    phone_number?: string;
    email?: string;
    consent_terms?: boolean;
    consent_privacy?: boolean;
  };
  if (
    !body.name ||
    (!body.phone_number && !body.email) ||
    !body.consent_terms ||
    !body.consent_privacy
  ) {
    throw httpError('SCHEMA_VALIDATION', {
      detail:
        'account_only requires name + (phone_number OR email) + consent_terms + consent_privacy',
    });
  }

  // Forward to signals with submit_mode=account_only forced.
  const result = await ss.onboard({
    submit_mode: 'account_only',
    network: link.network,
    domain: link.domain,
    source_id: link.id,
    channel: 'link',
    name: body.name,
    phone_number: body.phone_number,
    email: body.email,
    terms_accepted: body.consent_terms,
    privacy_accepted: body.consent_privacy,
    // ... whatever other fields onboard() requires for account-only mode
  });

  // Skip dispatcher fan-out entirely — account_only links never enqueue.
  // (Do NOT call planCompletionDispatch.)

  // Record the submission, then return.
  // Match the existing audit/log/response shape, but with lifecycle_status
  // and completion_pct forced to null.
  return reply.code(201).send({
    /* ... existing response shape ... */
    submission_mode: 'account_only',
    lifecycle_status: null,
    completion_pct: null,
    owned_elsewhere: result.value?.owned_elsewhere ?? false,
  });
}

// Existing account_and_profile branch continues unchanged below.
```

Adjust property names to match the actual handler's variables — read the surrounding code first.

- [ ] **Step 4: Run tests, verify PASS**

```bash
pnpm --filter @aggregator-dpg/api test -- public-registration-links.submission-mode
# expect: all PASS
pnpm --filter @aggregator-dpg/api test -- public-registration-links.lifecycle
# expect: PASS (regression — full-mode behaviour unchanged)
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/public-registration-links.ts apps/api/src/routes/__tests__/public-registration-links.submission-mode.test.ts
git commit -m "feat(api): public submit branches on submission_mode — account_only path"
```

---

## Task 8: Forbid `completion_actions` on `account_only` create

**Files:**

- Modify: `apps/api/src/routes/registration-links.ts` (create handler)
- Modify: `apps/api/src/routes/__tests__/registration-links.submission-mode.test.ts` (extend)

`completion_actions` is not currently exposed on the admin POST body. This task adds the field to the create body (so it's settable end-to-end) AND the guard that blocks it for `account_only`. If you confirm via grep that `completion_actions` IS exposed elsewhere (e.g. a different admin endpoint), skip the schema-add half and only add the guard at create time.

- [ ] **Step 1: Write the failing test**

Append to `registration-links.submission-mode.test.ts`:

```ts
it('rejects account_only + completion_actions[] with 400 INVALID_CONFIG', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/links/create',
    headers: { authorization: 'Bearer agg-token' },
    payload: {
      domain: 'seeker',
      submission_mode: 'account_only',
      completion_actions: [{ channel: 'sms', template_id: 't1', delay_seconds: 0, max_retries: 3 }],
    },
  });
  expect(r.statusCode).toBe(400);
  expect(r.json().code).toBe('INVALID_CONFIG');
});

it('allows account_and_profile + completion_actions[]', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/links/create',
    headers: { authorization: 'Bearer agg-token' },
    payload: {
      domain: 'seeker',
      submission_mode: 'account_and_profile',
      completion_actions: [{ channel: 'sms', template_id: 't1', delay_seconds: 0, max_retries: 3 }],
    },
  });
  expect(r.statusCode).toBe(201);
});
```

- [ ] **Step 2: Add `completion_actions` to `CreateLinkBodySchema` and add the guard**

In `registration-links.ts`:

```ts
const CompletionActionSchema = z.object({
  channel: z.enum(['sms', 'voice', 'chat']),
  template_id: z.string().min(1),
  delay_seconds: z.number().int().min(0).default(0),
  max_retries: z.number().int().min(0).default(3),
});

const CreateLinkBodySchema = z.object({
  // ... existing fields ...
  submission_mode: z.enum(['account_only', 'account_and_profile']).default('account_and_profile'),
  completion_actions: z.array(CompletionActionSchema).default([]),
  // ... rest ...
});
```

In the create handler, after `parsed.success` validation:

```ts
const body = parsed.data;
if (body.submission_mode === 'account_only' && body.completion_actions.length > 0) {
  throw httpError('INVALID_CONFIG', {
    detail: 'completion_actions are not allowed on account_only links',
  });
}
```

If `INVALID_CONFIG` is not already an error code, add it to `apps/api/src/errors/codes.ts` (same shape as the codes added in Task 3).

Thread `completionActions: body.completion_actions` into the insert values.

- [ ] **Step 3: Run tests, verify PASS**

```bash
pnpm --filter @aggregator-dpg/api test -- registration-links.submission-mode
# expect: both new tests PASS
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/errors/codes.ts apps/api/src/routes/registration-links.ts apps/api/src/routes/__tests__/registration-links.submission-mode.test.ts
git commit -m "feat(api): forbid completion_actions on account_only links at create"
```

---

## Task 9: Web — `MinimalIdentityForm` component

**Files:**

- Create: `apps/web/src/app/[org]/[slug]/MinimalIdentityForm.tsx`
- Create: `apps/web/src/__tests__/components/MinimalIdentityForm.test.tsx`
- Modify: `apps/web/src/i18n/messages/en.json`
- Modify: `apps/web/src/i18n/messages/hi.json`
- Modify: `apps/web/src/i18n/messages/kn.json`

- [ ] **Step 1: Add i18n keys**

To `en.json`, under `Registration` (or wherever existing registration keys live), add:

```json
"Registration": {
  ...,
  "account_only": {
    "title": "Quick sign-up",
    "helper": "Provide your name and a contact number or email. You can complete your profile later.",
    "contact_label": "Phone OR email (at least one)"
  }
}
```

Translate the three values for `hi.json` and `kn.json` — placeholder English values are acceptable for the first pass if the translator is not available; raise a TODO in CHANGELOG to backfill.

- [ ] **Step 2: Write the failing test**

```tsx
// apps/web/src/__tests__/components/MinimalIdentityForm.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MinimalIdentityForm } from '../../app/[org]/[slug]/MinimalIdentityForm';
import en from '../../i18n/messages/en.json';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('MinimalIdentityForm', () => {
  it('renders name + phone + email + consent fields', () => {
    render(wrap(<MinimalIdentityForm onSubmit={() => {}} />));
    expect(screen.getByLabelText(/name/i)).toBeDefined();
    expect(screen.getByLabelText(/phone/i)).toBeDefined();
    expect(screen.getByLabelText(/email/i)).toBeDefined();
  });

  it('disables submit when neither phone nor email is filled', () => {
    render(wrap(<MinimalIdentityForm onSubmit={() => {}} />));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'A. User' } });
    expect((screen.getByRole('button', { name: /submit/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('calls onSubmit with the identity-only payload when valid', () => {
    const onSubmit = vi.fn();
    render(wrap(<MinimalIdentityForm onSubmit={onSubmit} />));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'A. User' } });
    fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: '+919999999999' } });
    fireEvent.click(screen.getByLabelText(/terms/i));
    fireEvent.click(screen.getByLabelText(/privacy/i));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'A. User',
      phone_number: '+919999999999',
      email: undefined,
      consent_terms: true,
      consent_privacy: true,
    });
  });
});
```

- [ ] **Step 3: Run test, verify FAIL**

```bash
pnpm --filter @aggregator-dpg/web test -- MinimalIdentityForm
# expect: FAIL — component does not exist
```

- [ ] **Step 4: Create the component**

```tsx
// apps/web/src/app/[org]/[slug]/MinimalIdentityForm.tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

export interface MinimalIdentityPayload {
  name: string;
  phone_number?: string;
  email?: string;
  consent_terms: true;
  consent_privacy: true;
}

interface Props {
  onSubmit: (payload: MinimalIdentityPayload) => void;
}

export function MinimalIdentityForm({ onSubmit }: Props): JSX.Element {
  const t = useTranslations('Registration.account_only');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);

  const valid = name.length > 0 && (phone.length > 0 || email.length > 0) && terms && privacy;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit({
          name,
          phone_number: phone || undefined,
          email: email || undefined,
          consent_terms: true,
          consent_privacy: true,
        });
      }}
    >
      <h2>{t('title')}</h2>
      <p>{t('helper')}</p>

      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>

      <fieldset>
        <legend>{t('contact_label')}</legend>
        <label>
          Phone
          <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" />
        </label>
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
        </label>
      </fieldset>

      <label>
        I accept the terms
        <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
      </label>

      <label>
        I accept the privacy policy
        <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} />
      </label>

      <button type="submit" disabled={!valid}>
        Submit
      </button>
    </form>
  );
}
```

(Adjust class names, design tokens, and form layout to match the existing `PublicRegistrationView` styling. Read it once before writing.)

- [ ] **Step 5: Run tests, verify PASS**

```bash
pnpm --filter @aggregator-dpg/web test -- MinimalIdentityForm
# expect: 3 PASS
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/\[org\]/\[slug\]/MinimalIdentityForm.tsx apps/web/src/__tests__/components/MinimalIdentityForm.test.tsx apps/web/src/i18n/messages/
git commit -m "feat(web): MinimalIdentityForm for account_only links + i18n"
```

---

## Task 10: Web — page.tsx + PublicRegistrationView branch

**Files:**

- Modify: `apps/web/src/app/[org]/[slug]/page.tsx`
- Modify: `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx`
- Create: `apps/web/src/__tests__/views/PublicRegistrationView.submission-mode.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/__tests__/views/PublicRegistrationView.submission-mode.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { PublicRegistrationView } from '../../app/[org]/[slug]/PublicRegistrationView';
import en from '../../i18n/messages/en.json';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {node}
    </NextIntlClientProvider>
  );
}

const baseProps = {
  org: 'acme',
  slug: 'walk-in-2026',
  network: 'blue_dot',
  domain: 'seeker',
  context: {},
  schemaId: 's',
  schemaVersion: 'v1',
  schema: null,
  identity: { name: 'name', phone: 'phone_number', email: 'email' },
  expiresAt: null,
};

describe('PublicRegistrationView — submission_mode', () => {
  it('renders MinimalIdentityForm when submission_mode is account_only', () => {
    render(wrap(<PublicRegistrationView {...baseProps} submissionMode="account_only" />));
    expect(screen.getByRole('heading', { name: /quick sign-up/i })).toBeDefined();
  });

  it('renders the full RJSF form when submission_mode is account_and_profile', () => {
    render(
      wrap(
        <PublicRegistrationView
          {...baseProps}
          submissionMode="account_and_profile"
          schema={{ type: 'object', properties: {} }}
        />,
      ),
    );
    expect(screen.queryByRole('heading', { name: /quick sign-up/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm --filter @aggregator-dpg/web test -- PublicRegistrationView.submission-mode
# expect: FAIL — submissionMode prop unknown
```

- [ ] **Step 3: Extend `ResolveResponse` and `PageProps` in `page.tsx`**

```ts
interface ResolveResponse {
  // ... existing fields ...
  submission_mode?: 'account_only' | 'account_and_profile'; // optional for back-compat
  schema: RJSFSchema | null; // now nullable
  // ...
}
```

In the page component, pass it through:

```tsx
<PublicRegistrationView
  // ... existing props ...
  submissionMode={resolved.submission_mode ?? 'account_and_profile'}
/>
```

- [ ] **Step 4: Add the branch in `PublicRegistrationView.tsx`**

Top of the component:

```tsx
import { MinimalIdentityForm } from './MinimalIdentityForm';

interface Props {
  // ... existing props ...
  submissionMode: 'account_only' | 'account_and_profile';
}

export function PublicRegistrationView(props: Props): JSX.Element {
  // ... existing pre-submit lookup logic stays unchanged — runs for both modes ...

  if (props.submissionMode === 'account_only') {
    const submitIdentityOnly = async (payload: MinimalIdentityPayload) => {
      // Pre-submit lookup probe — reuse the same helper the full-mode
      // path uses (already defined in this file as `runIdentityProbe`).
      const probe = await runIdentityProbe({
        email: payload.email,
        phone: payload.phone_number,
        network: props.network,
        domain: props.domain,
      });
      if (probe.kind === 'owned_elsewhere') {
        setLookup({ kind: 'owned_elsewhere' });
        return;
      }
      // Submit identity-only body to the BFF (same route the full form uses).
      const res = await fetch(`/api/${props.org}/${props.slug}/registrations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.detail ?? 'Submission failed');
        return;
      }
      setSuccess(true);
    };
    return <MinimalIdentityForm onSubmit={submitIdentityOnly} />;
  }

  // Existing full-mode rendering stays below unchanged.
  return /* existing JSX */;
}
```

If `runIdentityProbe`, `setLookup`, `setError`, or `setSuccess` are not the exact names used in the existing view, substitute the actual ones — read the top of `PublicRegistrationView.tsx` to see the helpers and state setters.

- [ ] **Step 5: Run tests, verify PASS**

```bash
pnpm --filter @aggregator-dpg/web test -- PublicRegistrationView
# expect: PASS (new submission-mode tests + existing lookup tests still green)
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/\[org\]/\[slug\]/page.tsx apps/web/src/app/\[org\]/\[slug\]/PublicRegistrationView.tsx apps/web/src/__tests__/views/PublicRegistrationView.submission-mode.test.tsx
git commit -m "feat(web): PublicRegistrationView branches on submission_mode"
```

---

## Task 11: Integration sweep + push + draft PR

- [ ] **Step 1: Full workspace sweep**

```bash
pnpm -w lint
pnpm -w typecheck
pnpm -w test
pnpm dep-check
```

Expected: all green. Fix any drift inline.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/account-only-onboarding-mode
```

- [ ] **Step 3: Open a draft PR**

```bash
gh pr create --draft \
  --base feat/aggregator-onboarding-lifecycle-followup \
  --head feat/account-only-onboarding-mode \
  --title "feat: per-link submission_mode (account_only vs account_and_profile)" \
  --body-file - <<'EOF'
## Summary

Adds per-link `submission_mode` toggle. Spec:
`docs/superpowers/specs/2026-06-08-per-link-submission-mode-design.md`.

Decisions locked at brainstorm: column named `submission_mode` (not
`onboarding_mode` to avoid collision with the bulk/qr/link delivery-channel
concept); `account_only` and `account_and_profile`; mode is immutable
post-create; `account_only` links never enqueue the dispatcher;
`completion_actions[]` forbidden on `account_only` links at create time;
identity required for `account_only` = name + (phone OR email) + consent.

## What's in this PR

- DB: additive column `submission_mode` on `registration_links` (default `account_and_profile`)
- Admin create accepts the new field + forbids `account_only + completion_actions`
- Admin update rejects the field (existing `.strict()` schema)
- Public resolve surfaces `submission_mode` + nulls `schema` for `account_only`
- Public submit branches on mode — `account_only` path is identity-only, no dispatcher
- Web: new `MinimalIdentityForm` component, `PublicRegistrationView` branches on prop
- i18n keys in en/hi/kn for the minimal form

## Out of scope

- Admin UI toggle for the field (API-only this PR)
- Real outbound vendor adapters (stub still in place from parent branch)
- Future modes (`kyc_only` etc.) — column is extensible

## Status

Draft until reviewer confirms naming + scope.

🤖 Generated with [Claude Code](https://claude.ai/code)
EOF
```

---

## Out of scope (called out in spec, deferred)

- Admin UI for the toggle.
- Re-mode of existing links (explicitly rejected).
- `kyc_only` / `identity_only_no_name` modes — enum is extensible but no values land here.
- Cross-link analytics on mode usage.

## Roll-forward / roll-back notes

- Migration is additive (`ALTER TABLE ... ADD COLUMN ... DEFAULT ...`). Safe under concurrent writes.
- Older API callers omitting `submission_mode` on create → defaults to `account_and_profile`.
- Older clients reading the public resolve response without expecting `submission_mode` → forward-compatible (extra field ignored).
- Web form treats missing `submissionMode` prop as `account_and_profile` (matches resolve default).
- If we need to roll back: dropping the column would require deleting the gate code in the create/submit handlers. Easier: leave the column in place and stop using the field (return `account_and_profile` from resolve unconditionally).
