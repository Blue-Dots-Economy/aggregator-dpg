# Registration Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the per-link admin concept from `submission_mode` to `registration_mode` and move the mode → form-shape mapping into per-network config (`aggregator.config.yaml`). Two modes ship: `voice` (account-only form + hint) and `form` (full RJSF + silent partial-accept).

**Architecture:** New per-network config block `registration_modes` maps each admin-facing mode key to a `submission_shape` (account_only | account_and_profile) + optional `public_hint_i18n_key`. DB drops `submission_mode` and adds `registration_mode` (open snake_case text). Handlers resolve shape via config on every request — no resolved-shape persistence. Web admin form sources options from the live config; public form branches on the resolved shape.

**Tech Stack:** Zod for config validation, Drizzle ORM + Postgres, Fastify, Next.js App Router, next-intl, Vitest, TypeScript-only.

---

## Spec ↔ Codebase Reconciliation

| Spec calls it                                                        | Actual location                                                                                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/<network>/aggregator.config.yaml` `registration_modes` block | Lives under the existing `aggregator:` root in the YAML — schema in `packages/network-config/src/interface.ts`; loader in `packages/network-config/src/loader.ts` |
| Network config consumed by the web admin form                        | `useAggregatorConfig` hook reads from `GET /v1/aggregator-config` (exposed by the api)                                                                            |
| `POST /admin/v1/registration-links`                                  | `POST /v1/links/create` in `apps/api/src/routes/registration-links.ts`                                                                                            |
| `GET /public/v1/aggregators/:org/links/:slug`                        | Same path — handler in `apps/api/src/routes/public-registration-links.ts`                                                                                         |
| `POST /public/v1/aggregators/:org/registrations/:slug`               | Same path — same file                                                                                                                                             |

`submission_mode` column + tests + UI live on the current draft branch (PR #401). They are removed by this plan and replaced with the registration_mode equivalents.

---

## File Map

**Network config schema:**

- Modify: `packages/network-config/src/interface.ts` — add `RegistrationModeSchema` + `registration_modes` field on `AggregatorConfigSchema`
- Modify: `packages/network-config/src/testing.ts` — fixtures include the new block
- Modify: `packages/network-config/src/__tests__/*` — parser tests

**Aggregator config:**

- Modify: `config/purple_dot/aggregator.config.yaml` — add `registration_modes` block

**Database:**

- Modify: `packages/db-schema/src/schema.ts` — drop `submissionMode`, add `registrationMode`
- Create: `apps/api/drizzle/migrations/0015_registration_mode.sql`
- Modify: `apps/api/drizzle/migrations/meta/_journal.json`
- Modify: `packages/db-schema/src/__tests__/schema.test.ts`

**Errors:**

- Modify: `apps/api/src/errors/codes.ts` — rename `SUBMISSION_MODE_*` → `REGISTRATION_MODE_*`, add `INVALID_REGISTRATION_MODE`

**Store:**

- Modify: `apps/api/src/services/registration-links-store/interface.ts` — rename type, threaded fields
- Modify: `apps/api/src/services/registration-links-store/postgres.ts` — insert + toDomain

**API routes:**

- Modify: `apps/api/src/routes/registration-links.ts` — admin create accepts `registration_mode`, validates against live config
- Modify: `apps/api/src/routes/public-registration-links.ts` — resolve returns `registration_mode` + `submission_shape` + `public_hint_i18n_key`; submit branches on resolved shape; silent partial for `account_and_profile`
- Create: `apps/api/src/services/registration-mode/index.ts` — `resolveSubmissionShape(mode, cfg)` helper + tests

**API tests:**

- Modify: `apps/api/src/routes/__tests__/registration-links.submission-mode.test.ts` → rename to `registration-links.registration-mode.test.ts` and update assertions
- Modify: `apps/api/src/routes/__tests__/public-registration-links.submission-mode.test.ts` → rename + update

**Web admin:**

- Modify: `apps/web/src/services/onboarding.service.ts` — `CreateLinkInput.submission_mode` → `registration_mode: string` (any declared key); `ApiRegistrationLink.submission_mode` → `registration_mode`
- Modify: `apps/web/src/app/(protected)/onboarding/_components/RegistrationLinksSection.tsx` — dropdown sourced from `useAggregatorConfig`'s `registration_modes`

**Web public:**

- Modify: `apps/web/src/app/[org]/[slug]/page.tsx` — extend `ResolveResponse` with `registration_mode` + `submission_shape` + `public_hint_i18n_key`, thread to view
- Modify: `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx` — branch on `submissionShape` (rename prop); remove `partial` state + checkbox + bypassProbe; render hint when shape is `account_only`
- Modify: `apps/web/src/app/[org]/[slug]/MinimalIdentityForm.tsx` — accept `hintI18nKey` prop, render below submit

**i18n:**

- Modify: `apps/web/src/i18n/messages/en.json` — new `registration_mode.*` keys; remove obsolete keys
- Modify: `apps/web/src/i18n/messages/hi.json` — same
- Modify: `apps/web/src/i18n/messages/kn.json` — same

**Aggregator-config BFF:**

- Modify: `apps/api/src/routes/aggregator-config.ts` (or wherever `GET /v1/aggregator-config` lives) — include `registration_modes` block in the response

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

## Task 1: Zod schema for `registration_modes` block

**Files:**

- Modify: `packages/network-config/src/interface.ts` — append `RegistrationModeSchema` and extend `AggregatorConfigSchema`
- Modify: `packages/network-config/src/__tests__/loader.test.ts` (or whatever the existing parser test is named — search to confirm)

- [ ] **Step 1: Write the failing test**

Append to the existing `packages/network-config/src/__tests__/loader.test.ts` (or create if absent):

```ts
import { describe, it, expect } from 'vitest';
import { AggregatorConfigSchema } from '../interface.js';

describe('AggregatorConfigSchema.registration_modes', () => {
  const baseAggregator = {
    name: 'Test',
    contact_email: 'a@x.com',
    network: { source: 'http://x', csv_array_delimiter: '|', field_overrides: {} },
    brand: {
      short_name: 'T',
      long_name: 'Test',
      url_slug: 't',
      primary_color: '#000',
      accent_color: '#111',
    },
    domain_labels: {},
    onboarding: { presume_consent: true },
  };

  it('accepts a declared mode with required fields', () => {
    const result = AggregatorConfigSchema.safeParse({
      aggregator: {
        ...baseAggregator,
        registration_modes: {
          voice: {
            label_i18n_key: 'registration_mode.voice.label',
            submission_shape: 'account_only',
            public_hint_i18n_key: 'registration_mode.voice.hint',
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown submission_shape', () => {
    const result = AggregatorConfigSchema.safeParse({
      aggregator: {
        ...baseAggregator,
        registration_modes: {
          weird: {
            label_i18n_key: 'x',
            submission_shape: 'BOGUS',
            public_hint_i18n_key: null,
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts null public_hint_i18n_key', () => {
    const result = AggregatorConfigSchema.safeParse({
      aggregator: {
        ...baseAggregator,
        registration_modes: {
          form: {
            label_i18n_key: 'registration_mode.form.label',
            submission_shape: 'account_and_profile',
            public_hint_i18n_key: null,
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-snake_case mode keys', () => {
    const result = AggregatorConfigSchema.safeParse({
      aggregator: {
        ...baseAggregator,
        registration_modes: {
          'Bad-Key': {
            label_i18n_key: 'x',
            submission_shape: 'account_only',
            public_hint_i18n_key: null,
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm --filter @aggregator-dpg/network-config test
# expect: 4 tests fail — registration_modes not declared
```

- [ ] **Step 3: Add the Zod schema**

In `packages/network-config/src/interface.ts`, add near the other schemas:

```ts
const RegistrationModeKey = z.string().regex(/^[a-z][a-z0-9_]*$/);

export const RegistrationModeSchema = z.object({
  label_i18n_key: z.string().min(1),
  submission_shape: z.enum(['account_only', 'account_and_profile']),
  public_hint_i18n_key: z.string().min(1).nullable(),
});

export type RegistrationMode = z.infer<typeof RegistrationModeSchema>;
```

Find `AggregatorConfigSchema` in the same file. Inside the `.object({ ... })` literal under `aggregator:`, add:

```ts
  registration_modes: z.record(RegistrationModeKey, RegistrationModeSchema).default({
    form: {
      label_i18n_key: 'registration_mode.form.label',
      submission_shape: 'account_and_profile',
      public_hint_i18n_key: null,
    },
  }),
```

(The default block ensures existing networks without the block get a `form`-only configuration.)

- [ ] **Step 4: Run test, verify PASS**

```bash
pnpm --filter @aggregator-dpg/network-config test
# expect: 4 PASS
pnpm --filter @aggregator-dpg/network-config typecheck
# expect: clean
```

- [ ] **Step 5: Commit**

```bash
git add packages/network-config/src/interface.ts packages/network-config/src/__tests__/
git commit -m "feat(network-config): registration_modes block schema"
```

---

## Task 2: Update network-config testing fixtures

**Files:**

- Modify: `packages/network-config/src/testing.ts`

The `buildBlueDotConfig` / `buildPurpleDotConfig` / `buildOrangeDotConfig` fixtures used in tests need the new block so consumer tests don't break.

- [ ] **Step 1: Find each builder and append the new block**

Open `packages/network-config/src/testing.ts`. Locate each `build<Network>Config(): NetworkConfig` function. Inside the returned `aggregator: { ... }` object, add:

```ts
    registration_modes: {
      voice: {
        label_i18n_key: 'registration_mode.voice.label',
        submission_shape: 'account_only',
        public_hint_i18n_key: 'registration_mode.voice.hint',
      },
      form: {
        label_i18n_key: 'registration_mode.form.label',
        submission_shape: 'account_and_profile',
        public_hint_i18n_key: null,
      },
    },
```

If the function uses a spread + override pattern (e.g. `{ ...baseAggregator, registration_modes: ... }`), the block goes at the spread level.

- [ ] **Step 2: Run all package tests, verify still green**

```bash
pnpm -w test 2>&1 | tail -3
# expect: all green
```

- [ ] **Step 3: Commit**

```bash
git add packages/network-config/src/testing.ts
git commit -m "test(network-config): fixtures declare registration_modes"
```

---

## Task 3: Add `registration_modes` to purple_dot aggregator.config.yaml

**Files:**

- Modify: `config/purple_dot/aggregator.config.yaml`

- [ ] **Step 1: Add the block**

Open `config/purple_dot/aggregator.config.yaml`. Find the closing of `aggregator:` (it's the only root key). Inside the `aggregator:` block, before any closing dedent, add:

```yaml
# Per-link registration modes. Each key names an admin-facing channel.
# `submission_shape` decides what the public form renders:
#   - account_only        : MinimalIdentityForm (name + phone OR email + consent).
#   - account_and_profile : full RJSF profile schema; partial submissions accepted.
# `public_hint_i18n_key` is the i18n key rendered beneath the form;
# null means no hint.
registration_modes:
  voice:
    label_i18n_key: registration_mode.voice.label
    submission_shape: account_only
    public_hint_i18n_key: registration_mode.voice.hint
  form:
    label_i18n_key: registration_mode.form.label
    submission_shape: account_and_profile
    public_hint_i18n_key: null
```

- [ ] **Step 2: Restart api locally + verify config loads**

```bash
docker compose restart api
sleep 4
docker compose logs api --tail 20 2>&1 | grep -iE "config|registration"
# expect: 'network config resolved' log line; no zod parse error
```

- [ ] **Step 3: Commit**

```bash
git add config/purple_dot/aggregator.config.yaml
git commit -m "config(purple_dot): declare voice + form registration_modes"
```

---

## Task 4: DB column rename — drop submission_mode, add registration_mode

**Files:**

- Modify: `packages/db-schema/src/schema.ts`
- Modify: `packages/db-schema/src/__tests__/schema.test.ts`
- Create: `apps/api/drizzle/migrations/0015_registration_mode.sql`
- Modify: `apps/api/drizzle/migrations/meta/_journal.json`

- [ ] **Step 1: Write the failing test**

Replace the existing `describe('registrationLinks.submissionMode', ...)` block in `packages/db-schema/src/__tests__/schema.test.ts` with:

```ts
describe('registrationLinks.registrationMode', () => {
  it('is declared as a non-null text column with the snake_case SQL name', () => {
    const col = registrationLinks.registrationMode;
    expect(col).toBeDefined();
    expect(col.name).toBe('registration_mode');
    expect(col.notNull).toBe(true);
  });

  it('does NOT expose a submissionMode column anymore', () => {
    expect((registrationLinks as Record<string, unknown>).submissionMode).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm --filter @aggregator-dpg/db-schema test
# expect: registrationMode test fails (still submissionMode)
```

- [ ] **Step 3: Rename the Drizzle column**

In `packages/db-schema/src/schema.ts`, inside `registrationLinks`, replace:

```ts
    submissionMode: text('submission_mode')
      .$type<'account_only' | 'account_and_profile'>()
      .notNull()
      .default('account_and_profile'),
```

with:

```ts
    registrationMode: text('registration_mode').notNull().default('form'),
```

(No `$type` constraint — mode keys are open snake_case strings validated at the app layer.)

- [ ] **Step 4: Write the SQL migration**

Create `apps/api/drizzle/migrations/0015_registration_mode.sql`:

```sql
-- Migration 0015 — rename per-link submission_mode → registration_mode.
--
-- Drops the closed-enum `submission_mode` column (introduced in 0014)
-- and adds a fresh open-text `registration_mode` column whose value is
-- validated against the live network config's `registration_modes`
-- block at the application layer. Default 'form' (full RJSF + silent
-- partial-accept). No data backfill required — submission_mode was
-- only in local development DBs.

ALTER TABLE "registration_links" DROP COLUMN IF EXISTS "submission_mode";

ALTER TABLE "registration_links"
  ADD COLUMN IF NOT EXISTS "registration_mode" text NOT NULL DEFAULT 'form';

DO $$ BEGIN
  ALTER TABLE "registration_links"
    ADD CONSTRAINT "registration_links_registration_mode_check"
    CHECK ("registration_mode" ~ '^[a-z][a-z0-9_]*$');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
```

- [ ] **Step 5: Update the migration journal**

Append to `apps/api/drizzle/migrations/meta/_journal.json` entries array (before the closing `]`):

```json
{
  "idx": 15,
  "version": "7",
  "when": 1779500000000,
  "tag": "0015_registration_mode",
  "breakpoints": true
}
```

- [ ] **Step 6: Apply the migration locally**

```bash
docker compose exec -T postgres psql -U aggregator -d aggregator < apps/api/drizzle/migrations/0015_registration_mode.sql
# expect: ALTER TABLE + ALTER TABLE + DO
docker compose exec -T postgres psql -U aggregator -d aggregator -c "\d registration_links" | grep -E "submission_mode|registration_mode"
# expect: only registration_mode visible
```

- [ ] **Step 7: Rebuild db-schema dist + verify db-schema tests pass**

```bash
pnpm --filter @aggregator-dpg/db-schema build
pnpm --filter @aggregator-dpg/db-schema test
# expect: 4 PASS (the two new specs + the prior outboundDispatchLog ones)
```

- [ ] **Step 8: Commit**

```bash
git add packages/db-schema/ apps/api/drizzle/migrations/0015_registration_mode.sql apps/api/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): rename submission_mode -> registration_mode"
```

---

## Task 5: Update store types + insert + toDomain

**Files:**

- Modify: `apps/api/src/services/registration-links-store/interface.ts`
- Modify: `apps/api/src/services/registration-links-store/postgres.ts`

- [ ] **Step 1: Update RegistrationLink + CreateRegistrationLinkInput**

In `interface.ts`, find and replace the `RegistrationLinkSubmissionMode` block + the two usages:

```ts
// Remove:
export type RegistrationLinkSubmissionMode = 'account_only' | 'account_and_profile';

// Inside RegistrationLink interface, remove:
  submissionMode: RegistrationLinkSubmissionMode;

// Inside CreateRegistrationLinkInput interface, remove:
  submissionMode?: RegistrationLinkSubmissionMode;
```

Replace with:

```ts
// Top-level:
/**
 * Per-link admin-facing registration mode key. The mode → form-shape
 * mapping lives in network config (aggregator.config.yaml under
 * `registration_modes`); unknown keys at read time fall back to `form`
 * shape via resolveSubmissionShape() (see services/registration-mode).
 * Open snake_case identifier; not constrained to a fixed enum.
 */
export type RegistrationLinkRegistrationMode = string;

// Inside RegistrationLink:
  registrationMode: RegistrationLinkRegistrationMode;

// Inside CreateRegistrationLinkInput:
  registrationMode?: RegistrationLinkRegistrationMode;
```

- [ ] **Step 2: Update postgres adapter insert + toDomain**

In `postgres.ts`, find the `submissionMode` assignment in the insert values and the toDomain mapper. Replace:

```ts
// Inside .values({ ... }):
          submissionMode: input.submissionMode ?? 'account_and_profile',

// Inside toDomain():
    submissionMode:
      row.submissionMode === 'account_only' || row.submissionMode === 'account_and_profile'
        ? row.submissionMode
        : 'account_and_profile',
```

with:

```ts
// Inside .values({ ... }):
          registrationMode: input.registrationMode ?? 'form',

// Inside toDomain():
    registrationMode: typeof row.registrationMode === 'string' ? row.registrationMode : 'form',
```

- [ ] **Step 3: Run db-schema build + api typecheck**

```bash
pnpm --filter @aggregator-dpg/db-schema build
pnpm --filter @aggregator-dpg/api typecheck
# expect: errors in routes that reference submissionMode — fixed in later tasks; OK if api fails here
```

This task intentionally leaves the API broken — Tasks 6–10 fix each downstream consumer.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/registration-links-store/
git commit -m "refactor(store): rename submissionMode -> registrationMode in store types + postgres"
```

---

## Task 6: Rename error codes

**Files:**

- Modify: `apps/api/src/errors/codes.ts`

- [ ] **Step 1: Replace the SUBMISSION*MODE*_ block with the REGISTRATION*MODE*_ block**

In `apps/api/src/errors/codes.ts`, locate the existing block:

```ts
  // ── Submission mode (per-link account_only vs account_and_profile) ──────
  SUBMISSION_MODE_MISMATCH: { ... },
  SUBMISSION_MODE_IMMUTABLE: { ... },
  INVALID_CONFIG: { ... },
```

Replace with:

```ts
  // ── Registration mode (per-link admin channel; voice / form / future) ──
  REGISTRATION_MODE_MISMATCH: {
    code: 'REGISTRATION_MODE_MISMATCH',
    status: 400,
    title: 'Registration mode mismatch',
    detail:
      'This registration link only accepts identity fields (name + phone or email + consent). It does not accept profile data.',
    hint: 'POST body to a link whose registration_mode resolves to submission_shape=account_only included item_state or unknown fields. Server rejects to prevent profile leakage into an account-only capture.',
  },
  REGISTRATION_MODE_IMMUTABLE: {
    code: 'REGISTRATION_MODE_IMMUTABLE',
    status: 400,
    title: 'Registration mode cannot be changed',
    detail:
      'The registration mode is fixed at link creation time. Create a new link to use a different mode.',
    hint: 'PATCH /v1/links/:id included registration_mode. Immutable by design — UpdateLinkBodySchema is .strict() so unknown keys 400 automatically.',
  },
  INVALID_REGISTRATION_MODE: {
    code: 'INVALID_REGISTRATION_MODE',
    status: 400,
    title: 'Invalid registration mode',
    detail:
      'The selected registration mode is not declared in this network configuration.',
    hint: 'Create body referenced a mode key not present in aggregator.config.yaml registration_modes. Surface the declared keys via fields.declared.',
  },
  INVALID_CONFIG: {
    code: 'INVALID_CONFIG',
    status: 400,
    title: 'Invalid configuration',
    detail: 'The combination of fields supplied is not allowed by the API.',
    hint: 'A field combination violates a business invariant (e.g. completion_actions on a registration_mode whose submission_shape is account_only). Inspect detail for the specific rule.',
  },
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @aggregator-dpg/api typecheck 2>&1 | grep -E "SUBMISSION_MODE_|INVALID_REGISTRATION_MODE|REGISTRATION_MODE_" | head -10
# expect: errors at remaining call sites — fixed in Tasks 7-10
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/errors/codes.ts
git commit -m "feat(api): rename SUBMISSION_MODE_* error codes to REGISTRATION_MODE_*"
```

---

## Task 7: Resolver helper + tests

**Files:**

- Create: `apps/api/src/services/registration-mode/index.ts`
- Create: `apps/api/src/services/registration-mode/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/registration-mode/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveSubmissionShape, isModeDeclared } from './index.js';
import type { NetworkConfig } from '@aggregator-dpg/network-config/interface';

const cfg = {
  aggregator: {
    registration_modes: {
      voice: {
        label_i18n_key: 'registration_mode.voice.label',
        submission_shape: 'account_only',
        public_hint_i18n_key: 'registration_mode.voice.hint',
      },
      form: {
        label_i18n_key: 'registration_mode.form.label',
        submission_shape: 'account_and_profile',
        public_hint_i18n_key: null,
      },
    },
  },
} as unknown as NetworkConfig;

describe('resolveSubmissionShape', () => {
  it('returns the configured shape for a declared mode', () => {
    expect(resolveSubmissionShape('voice', cfg)).toBe('account_only');
    expect(resolveSubmissionShape('form', cfg)).toBe('account_and_profile');
  });

  it('returns account_and_profile (graceful default) for an unknown mode', () => {
    expect(resolveSubmissionShape('sms_campaign', cfg)).toBe('account_and_profile');
  });
});

describe('isModeDeclared', () => {
  it('true for declared keys', () => {
    expect(isModeDeclared('voice', cfg)).toBe(true);
    expect(isModeDeclared('form', cfg)).toBe(true);
  });
  it('false for unknown keys', () => {
    expect(isModeDeclared('kiosk', cfg)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm --filter @aggregator-dpg/api test -- registration-mode
# expect: FAIL — module not found
```

- [ ] **Step 3: Write the resolver**

Create `apps/api/src/services/registration-mode/index.ts`:

```ts
/**
 * Resolves a per-link `registration_mode` key to its runtime form shape
 * via the live network config. Unknown keys fall back to
 * `account_and_profile` so a config drift (mode key removed but live
 * links still reference it) never blows up; the worst case is the link
 * renders the full form by accident.
 *
 * Single source of truth: aggregator.config.yaml under
 * `aggregator.registration_modes`. The DB column is just a key.
 */
import type { NetworkConfig } from '@aggregator-dpg/network-config/interface';

export type SubmissionShape = 'account_only' | 'account_and_profile';

export function resolveSubmissionShape(mode: string, cfg: NetworkConfig): SubmissionShape {
  const modes = cfg.aggregator.registration_modes ?? {};
  return modes[mode]?.submission_shape ?? 'account_and_profile';
}

export function isModeDeclared(mode: string, cfg: NetworkConfig): boolean {
  const modes = cfg.aggregator.registration_modes ?? {};
  return Object.prototype.hasOwnProperty.call(modes, mode);
}

export function declaredModes(cfg: NetworkConfig): string[] {
  return Object.keys(cfg.aggregator.registration_modes ?? {});
}

export function defaultMode(cfg: NetworkConfig): string {
  const keys = declaredModes(cfg);
  return keys[0] ?? 'form';
}

export function publicHintI18nKey(mode: string, cfg: NetworkConfig): string | null {
  const modes = cfg.aggregator.registration_modes ?? {};
  return modes[mode]?.public_hint_i18n_key ?? null;
}
```

- [ ] **Step 4: Verify tests pass**

```bash
pnpm --filter @aggregator-dpg/api test -- registration-mode
# expect: 4 PASS
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/registration-mode/
git commit -m "feat(api): registration-mode resolver (mode -> submission_shape via network config)"
```

---

## Task 8: Admin create handler — accept `registration_mode`

**Files:**

- Modify: `apps/api/src/routes/registration-links.ts`
- Modify: `apps/api/src/routes/registration-links.submission-mode.test.ts` → rename to `registration-links.registration-mode.test.ts`

- [ ] **Step 1: Rename + update tests**

Rename:

```bash
git mv apps/api/src/routes/registration-links.submission-mode.test.ts apps/api/src/routes/registration-links.registration-mode.test.ts
```

Then in the renamed file, do a global rename `submission_mode` → `registration_mode`, `submissionMode` → `registrationMode`, `account_only` → `voice`, `account_and_profile` → `form`. Update expectations:

- Default mode is `form`.
- Test that `INVALID_REGISTRATION_MODE` returns 400 when mode is `kiosk` (not declared in the blue_dot fixture from Task 2).
- Test that PATCH with `registration_mode` returns 400 SCHEMA_VALIDATION.
- Test that `voice` + `completion_actions[]` returns 400 INVALID_CONFIG.

A minimal version of the updated test file:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setAccessTokenVerifier, _resetJwks } from '../services/auth/access-token.js';
import {
  AggregatorStoreFake,
  _setAggregatorStore,
  buildAggregator,
} from '../services/aggregator-store/index.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';
import {
  _setRegistrationLinksStore,
  RegistrationLinksStoreBase,
  type RegistrationLink,
  type CreateRegistrationLinkInput,
  type StoreResult,
} from '../services/registration-links-store/index.js';
import { _setDbClients } from '../db/client.js';

const AGG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = 'org-signalstack-1';
const ORG_SLUG = 'acme';
const USER_ID = 'kc-user-1';

class TrackingRegistrationLinksStore extends RegistrationLinksStoreBase {
  readonly creates: CreateRegistrationLinkInput[] = [];
  private idCounter = 0;

  async create(input: CreateRegistrationLinkInput): Promise<StoreResult<RegistrationLink>> {
    this.creates.push(input);
    this.idCounter++;
    const now = new Date();
    const row: RegistrationLink = {
      id: `link-${this.idCounter}`,
      aggregatorId: input.aggregatorId,
      slug: input.slug,
      domain: input.domain,
      context: input.context,
      completionActions: input.completionActions ?? [],
      registrationMode: input.registrationMode ?? 'form',
      qrObjectKey: null,
      status: input.status ?? 'draft',
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    return { ok: true, value: row };
  }
  async findById() {
    return { ok: true as const, value: null };
  }
  async findBySlug() {
    return { ok: true as const, value: null };
  }
  async findByOrgAndSlug() {
    return { ok: true as const, value: null };
  }
  async updateQrKey() {
    return { ok: false as const, error: { code: 'DB_UNAVAILABLE' as const, message: 'stub' } };
  }
  async updateDraft() {
    return { ok: false as const, error: { code: 'DB_UNAVAILABLE' as const, message: 'stub' } };
  }
  async list() {
    return { ok: true as const, value: { rows: [], total: 0 } };
  }
  async updateStatus() {
    return { ok: false as const, error: { code: 'DB_UNAVAILABLE' as const, message: 'stub' } };
  }
}

const AUTH_TOKEN = 'agg-a-token';

function buildMetricsStubDb(): unknown {
  const c: any = {};
  c.select = () => c;
  c.from = () => c;
  c.where = () => c;
  c.groupBy = () => Promise.resolve([]);
  return c;
}

async function bootApp(): Promise<{ app: FastifyInstance; store: TrackingRegistrationLinksStore }> {
  _resetJwks();
  process.env.KEYCLOAK_URL = 'http://kc.local';
  process.env.KEYCLOAK_REALM = 'aggregator';
  _setNetworkConfig(buildBlueDotConfig());
  _setAccessTokenVerifier(async (token) => {
    if (token !== AUTH_TOKEN) throw new Error('invalid');
    return {
      sub: USER_ID,
      email: 'a@x.com',
      aggregator_id: AGG_ID,
      aggregator_type: 'seeker',
      decision_made: 'approved',
    };
  });
  const aggStore = new AggregatorStoreFake();
  aggStore.seed([
    buildAggregator({
      id: AGG_ID,
      orgSlug: ORG_SLUG,
      name: 'Acme',
      status: 'active',
      signalstackOrgId: ORG_ID,
    }),
  ]);
  _setAggregatorStore(aggStore);
  const store = new TrackingRegistrationLinksStore();
  _setRegistrationLinksStore(store);
  _setDbClients(null, buildMetricsStubDb() as never);
  const app = await buildApp();
  return { app, store };
}

describe('POST /v1/links/create — registration_mode', () => {
  let app: FastifyInstance;
  let store: TrackingRegistrationLinksStore;
  beforeEach(async () => {
    ({ app, store } = await bootApp());
  });
  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setAggregatorStore(null);
    _setRegistrationLinksStore(null);
    _setNetworkConfig(null);
    _setDbClients(null, null);
  });

  it('defaults registration_mode to "form" when omitted', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().registration_mode).toBe('form');
    expect(store.creates[0]!.registrationMode).toBe('form');
  });

  it('accepts registration_mode=voice and persists it', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker', registration_mode: 'voice' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().registration_mode).toBe('voice');
  });

  it('rejects an undeclared mode with INVALID_REGISTRATION_MODE', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { domain: 'seeker', registration_mode: 'kiosk' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_REGISTRATION_MODE');
  });

  it('rejects voice + completion_actions[] with INVALID_CONFIG', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/links/create',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: {
        domain: 'seeker',
        registration_mode: 'voice',
        completion_actions: [
          { channel: 'sms', template_id: 't1', delay_seconds: 0, max_retries: 3 },
        ],
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_CONFIG');
  });
});

describe('PATCH /v1/links/:id — registration_mode immutability', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await bootApp());
  });
  afterEach(async () => {
    await app?.close();
    _setAccessTokenVerifier(null);
    _setAggregatorStore(null);
    _setRegistrationLinksStore(null);
    _setNetworkConfig(null);
    _setDbClients(null, null);
  });

  it('rejects body containing registration_mode with 400', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/links/00000000-0000-4000-8000-000000000001',
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      payload: { registration_mode: 'voice' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCHEMA_VALIDATION');
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm --filter @aggregator-dpg/api test -- registration-links.registration-mode
# expect: failures — handler still uses submission_mode
```

- [ ] **Step 3: Update the handler**

In `apps/api/src/routes/registration-links.ts`:

(a) Replace the `submission_mode` Zod field in `CreateLinkBodySchema`:

```ts
// Remove:
  submission_mode: z
    .enum(['account_only', 'account_and_profile'])
    .default('account_and_profile'),

// Add (open string with shape check; key-validity gated in handler):
  registration_mode: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
```

(b) In the create handler, after parsing the body, add:

```ts
const networkCfg = await getNetworkConfig();
const declared = Object.keys(networkCfg.aggregator.registration_modes ?? {});
const modeKey = body.registration_mode ?? declared[0] ?? 'form';
if (!declared.includes(modeKey)) {
  throw httpError('INVALID_REGISTRATION_MODE', {
    detail: `registration_mode '${modeKey}' is not declared for this network`,
    fields: { declared },
  });
}
const modeShape = networkCfg.aggregator.registration_modes[modeKey].submission_shape;
```

(c) Replace the existing `account_only + completion_actions` guard:

```ts
// Replace:
if (body.submission_mode === 'account_only' && body.completion_actions.length > 0) {
  throw httpError('INVALID_CONFIG', {
    detail: 'completion_actions are not allowed on account_only links',
  });
}
// With:
if (modeShape === 'account_only' && body.completion_actions.length > 0) {
  throw httpError('INVALID_CONFIG', {
    detail: `completion_actions are not allowed on registration_mode='${modeKey}' (submission_shape=account_only)`,
  });
}
```

(d) In the store.create call, replace `submissionMode: body.submission_mode` with `registrationMode: modeKey`.

(e) In `buildResponse`, replace the response key:

```ts
// Remove:
    submission_mode: row.submissionMode,
// Add:
    registration_mode: row.registrationMode,
```

- [ ] **Step 4: Typecheck + run tests**

```bash
pnpm --filter @aggregator-dpg/api typecheck 2>&1 | tail -3
pnpm --filter @aggregator-dpg/api test -- registration-links.registration-mode 2>&1 | tail -5
# expect: typecheck may still flag public-registration-links.ts — fixed in Task 9; admin tests should pass
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/registration-links.ts apps/api/src/routes/registration-links.registration-mode.test.ts
git rm apps/api/src/routes/registration-links.submission-mode.test.ts 2>/dev/null || true
git commit -m "feat(api): admin create accepts registration_mode (validated against live config)"
```

---

## Task 9: Public resolve + submit handlers

**Files:**

- Modify: `apps/api/src/routes/public-registration-links.ts`
- Modify: `apps/api/src/routes/public-registration-links.submission-mode.test.ts` → rename to `public-registration-links.registration-mode.test.ts`

- [ ] **Step 1: Update the resolve handler**

In `public-registration-links.ts`, find the GET handler. Replace the existing block that uses `link.submissionMode` with:

```ts
import { resolveSubmissionShape, publicHintI18nKey } from '../services/registration-mode/index.js';

// Inside the GET handler, after loading the link + networkCfg + linkDomainCfg:
const submissionShape = resolveSubmissionShape(link.registrationMode, networkCfg);
const hintKey = publicHintI18nKey(link.registrationMode, networkCfg);
const accountOnly = submissionShape === 'account_only';

return reply.send({
  slug: link.slug,
  network: networkCfg.network.id,
  domain: link.domain,
  context: link.context,
  registration_mode: link.registrationMode,
  submission_shape: submissionShape,
  public_hint_i18n_key: hintKey,
  schema_id: accountOnly ? null : `participant-${link.domain}`,
  schema_version: accountOnly ? null : 'v1',
  schema: accountOnly ? null : linkDomainCfg.schema,
  identity: linkDomainCfg.identity,
  expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
});
```

(Remove the old `link.submissionMode === 'account_only'` derivation in this handler.)

- [ ] **Step 2: Update the submit handler**

Find the `if (link.submissionMode === 'account_only')` block. Replace with:

```ts
const submissionShape = resolveSubmissionShape(link.registrationMode, networkCfgEarly);

if (submissionShape === 'account_only') {
  // … existing whitelist + identity-presence guard block, with all
  // SUBMISSION_MODE_MISMATCH httpError calls renamed to
  // REGISTRATION_MODE_MISMATCH …
}
```

Find every `httpError('SUBMISSION_MODE_MISMATCH', …)` and rename to `REGISTRATION_MODE_MISMATCH`.

(c) Replace the `partial` lifecycle hint derivation:

```ts
// Remove:
const partial = link.submissionMode === 'account_only' || rawBody['partial'] === true;

// Add:
const partial = submissionShape === 'account_only';
```

Drop `rawBody['partial']` handling entirely. The `delete body['partial']` line stays (harmless if the field is absent).

(d) Replace the dispatcher gate:

```ts
// Remove:
if (
  link.submissionMode !== 'account_only' &&
  onboardResultOut &&
  link.completionActions.length > 0
) {
// Add:
if (submissionShape !== 'account_only' && onboardResultOut && link.completionActions.length > 0) {
```

(e) Replace the Ajv-skip gate:

```ts
// Replace:
if (link.submissionMode !== 'account_only') {
  // ... existing schema validation block ...
}
// With (silent partial for account_and_profile):
if (submissionShape !== 'account_only') {
  // Schema validation. Empty cells already stripped above. We drop
  // `required`-keyword errors so partial submits land — signals'
  // classifier marks the resulting item `draft` when required fields
  // are missing, `live` otherwise. Type/format/pattern/enum/
  // additionalProperties errors still 400.
  // ... existing Ajv-load block ...
  if (!validate(body)) {
    const blocking = (validate.errors ?? []).filter((e) => e.keyword !== 'required');
    if (blocking.length > 0) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'Submission failed schema validation.',
        fields: { issues: blocking },
      });
    }
  }
}
```

(Remove the old `partial`-aware identity-filter block — it's superseded by the unconditional `required`-drop.)

(f) Replace the response `submission_mode` field with `registration_mode` + `submission_shape`:

```ts
// In both the 201 success branch and the 409 skipped branch:
// Remove:
        submission_mode: link.submissionMode,
// Add:
        registration_mode: link.registrationMode,
        submission_shape: submissionShape,
```

- [ ] **Step 3: Rename + update the test file**

```bash
git mv apps/api/src/routes/public-registration-links.submission-mode.test.ts apps/api/src/routes/public-registration-links.registration-mode.test.ts
```

In the renamed file, global rename `submissionMode` → `registrationMode`, `account_only` → `voice` (where it refers to a mode key on a link row), `account_and_profile` → `form` (same). Add a `submissionMode` → `registrationMode` rename on the seeded `RegistrationLink` constructor. Update body-key field name in the seeded `baseLink` (e.g. `submissionMode: 'account_only'` → `registrationMode: 'voice'`). Update each test's expected response body:

- `body.submission_mode` → `body.registration_mode`
- Add `expect(body.submission_shape).toBe(...)` where the test previously asserted `submission_mode`
- `SUBMISSION_MODE_MISMATCH` expectations → `REGISTRATION_MODE_MISMATCH`

- [ ] **Step 4: Typecheck + tests**

```bash
pnpm --filter @aggregator-dpg/api typecheck 2>&1 | tail -3
pnpm --filter @aggregator-dpg/api test -- public-registration-links 2>&1 | tail -8
# expect: green
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/public-registration-links.ts apps/api/src/routes/public-registration-links.registration-mode.test.ts
git rm apps/api/src/routes/public-registration-links.submission-mode.test.ts 2>/dev/null || true
git commit -m "feat(api): public resolve + submit honor registration_mode (config-driven shape)"
```

---

## Task 10: Aggregator-config endpoint exposes registration_modes

**Files:**

- Modify: `apps/api/src/routes/aggregator-config.ts` (or equivalent — confirm exact name via `grep -rn "/v1/aggregator-config" apps/api/src/routes/`)

- [ ] **Step 1: Find the handler**

```bash
grep -rn "/v1/aggregator-config" apps/api/src/routes/
```

The response builder converts the live network config into a UI-safe payload. It already exposes `brand`, `domain_labels`, `domains[]`. We add `registration_modes` so the web admin form can render the dropdown from config.

- [ ] **Step 2: Add the field to the response**

In the response builder (a `buildAggregatorConfigResponse` function or inline `reply.send({ ... })`), add alongside the existing fields:

```ts
registration_modes: networkCfg.aggregator.registration_modes,
```

(Stream the block verbatim — keys + sub-objects in the same shape the Zod schema validated.)

- [ ] **Step 3: Run aggregator-config tests + commit**

```bash
pnpm --filter @aggregator-dpg/api test -- aggregator-config 2>&1 | tail -5
# If existing tests assert the exact response shape, they'll fail; update them
# to include the new field. The Task 1 fixtures already declare it.
git add apps/api/src/routes/aggregator-config.ts apps/api/src/routes/__tests__/aggregator-config*.test.ts 2>/dev/null
git commit -m "feat(api): /v1/aggregator-config exposes registration_modes block"
```

---

## Task 11: Web admin form — dropdown sourced from config

**Files:**

- Modify: `apps/web/src/services/onboarding.service.ts`
- Modify: `apps/web/src/app/(protected)/onboarding/_components/RegistrationLinksSection.tsx`

- [ ] **Step 1: Update service types**

In `apps/web/src/services/onboarding.service.ts`:

```ts
// Remove from CreateLinkInput:
  submission_mode?: 'account_only' | 'account_and_profile';

// Add:
  registration_mode?: string;

// Remove from ApiRegistrationLink:
  submission_mode?: 'account_only' | 'account_and_profile';

// Add:
  registration_mode?: string;
```

- [ ] **Step 2: Update CreateLinkFormState + form**

In `RegistrationLinksSection.tsx`:

```ts
// In CreateLinkFormState, remove:
  submission_mode: 'account_only' | 'account_and_profile';
// Add:
  registration_mode: string;

// In EMPTY_FORM, remove:
  submission_mode: 'account_and_profile',
// Add:
  registration_mode: '',  // populated by the effect below from cfg.registration_modes
```

After the `cfg` is loaded (in `useAggregatorConfig`), add an effect that pins the default to the config's first declared mode:

```ts
useEffect(() => {
  const modes = cfg?.registration_modes ?? {};
  const keys = Object.keys(modes);
  const fallback = keys[0] ?? 'form';
  setForm((f) => (f.registration_mode ? f : { ...f, registration_mode: fallback }));
}, [cfg?.registration_modes]);
```

- [ ] **Step 3: Replace the dropdown**

Find the existing dropdown block (under `field_submission_mode`). Replace with:

```tsx
<Field label={t('create_link.field_registration_mode')} required>
  <select
    className="bd-input"
    value={form.registration_mode}
    onChange={(e) => setForm((f) => ({ ...f, registration_mode: e.target.value }))}
  >
    {Object.entries(cfg?.registration_modes ?? {}).map(([key, mode]) => {
      const m = mode as { label_i18n_key: string };
      return (
        <option key={key} value={key}>
          {t(m.label_i18n_key as any)}
        </option>
      );
    })}
  </select>
  <span className="block mt-1 text-[12px] text-ink-500">
    {(() => {
      const m = cfg?.registration_modes?.[form.registration_mode];
      if (!m?.public_hint_i18n_key) return null;
      return t(m.public_hint_i18n_key as any);
    })()}
  </span>
</Field>
```

(`t(literalString as any)` is required because next-intl's typed keys are static; runtime-config keys come in as strings.)

- [ ] **Step 4: Update onCreate**

```ts
// Remove:
        submission_mode: form.submission_mode,
// Add:
        registration_mode: form.registration_mode,
```

Also update the edit form's `useState` initialiser:

```ts
// Remove:
    submission_mode: link.submission_mode === 'account_only' ? 'account_only' : 'account_and_profile',
// Add:
    registration_mode: link.registration_mode ?? 'form',
```

- [ ] **Step 5: Verify**

```bash
pnpm --filter @aggregator-dpg/web typecheck 2>&1 | tail -3
pnpm --filter @aggregator-dpg/web test 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/services/onboarding.service.ts apps/web/src/app/\(protected\)/onboarding/_components/RegistrationLinksSection.tsx
git commit -m "feat(web): admin dropdown sources registration_modes from live config"
```

---

## Task 12: Web public view — branch on submission_shape; remove partial checkbox

**Files:**

- Modify: `apps/web/src/app/[org]/[slug]/page.tsx`
- Modify: `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx`
- Modify: `apps/web/src/app/[org]/[slug]/MinimalIdentityForm.tsx`

- [ ] **Step 1: Update page.tsx ResolveResponse**

```ts
// Remove:
  submission_mode?: 'account_only' | 'account_and_profile';
// Add:
  registration_mode?: string;
  submission_shape?: 'account_only' | 'account_and_profile';
  public_hint_i18n_key?: string | null;
```

In the component body, replace:

```ts
// Remove:
const submissionMode = resolved.submission_mode ?? 'account_and_profile';
if (submissionMode !== 'account_only') {
  // ...
}
// Add:
const submissionShape = resolved.submission_shape ?? 'account_and_profile';
const hintKey = resolved.public_hint_i18n_key ?? null;
if (submissionShape !== 'account_only') {
  // ...
}
```

In the `<PublicRegistrationView>` call, replace `submissionMode={submissionMode}` with:

```tsx
submissionShape = { submissionShape };
publicHintI18nKey = { hintKey };
```

- [ ] **Step 2: Update PublicRegistrationView props + branch**

Open `PublicRegistrationView.tsx`:

```ts
// Replace prop:
submissionMode?: 'account_only' | 'account_and_profile' | undefined;
// With:
submissionShape: 'account_only' | 'account_and_profile';
publicHintI18nKey: string | null;
```

In the destructuring, replace `submissionMode = 'account_and_profile'` with `submissionShape`, `publicHintI18nKey`.

Replace every internal `submissionMode === 'account_only'` with `submissionShape === 'account_only'`. Replace the early-render branch's MinimalIdentityForm invocation:

```tsx
<MinimalIdentityForm
  identity={identity ?? {}}
  onSubmit={handleMinimalSubmit}
  brandColor={heroGradient}
  hintI18nKey={publicHintI18nKey}
/>
```

Remove the `partial` state hook and the `<label>` for the partial checkbox entirely (search for `setPartial` / `partial_label` / `partial_hint`). Also drop the `partial: true` body field on the full-form submit POST:

```ts
// Replace:
body: JSON.stringify(partial ? { ...values, partial: true } : values),
// With:
body: JSON.stringify(values),
```

- [ ] **Step 3: Update MinimalIdentityForm to render the hint**

In `MinimalIdentityForm.tsx`:

```ts
// Add to MinimalIdentityFormProps:
  hintI18nKey?: string | null;
```

In the component, near the bottom of the form (just before `</form>`), add:

```tsx
{
  props.hintI18nKey && (
    <p className="text-[12.5px] text-ink-500 italic mt-1">
      {t.rich(props.hintI18nKey as any) ?? ''}
    </p>
  );
}
```

Wait — `useTranslations('profile.public_reg.account_only')` is scoped. To resolve an arbitrary key, use the global form:

```ts
// Replace top of component:
const t = useTranslations('profile.public_reg.account_only');
// With:
const t = useTranslations('profile.public_reg.account_only');
const tGlobal = useTranslations(); // global scope for the hint key
```

And render:

```tsx
{
  props.hintI18nKey && (
    <p className="text-[12.5px] text-ink-500 italic mt-1">{tGlobal(props.hintI18nKey as any)}</p>
  );
}
```

- [ ] **Step 4: Run web typecheck + tests**

```bash
pnpm --filter @aggregator-dpg/web typecheck 2>&1 | tail -3
pnpm --filter @aggregator-dpg/web test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\[org\]/\[slug\]/page.tsx apps/web/src/app/\[org\]/\[slug\]/PublicRegistrationView.tsx apps/web/src/app/\[org\]/\[slug\]/MinimalIdentityForm.tsx
git commit -m "feat(web): public view branches on submission_shape + renders hint; remove partial checkbox"
```

---

## Task 13: i18n keys

**Files:**

- Modify: `apps/web/src/i18n/messages/en.json`
- Modify: `apps/web/src/i18n/messages/hi.json`
- Modify: `apps/web/src/i18n/messages/kn.json`

- [ ] **Step 1: Add the new top-level `registration_mode` namespace in en.json**

Find a sensible insertion point (after `profile` or at top level — match prevailing organisation). Add:

```json
"registration_mode": {
  "field_label": "Registration mode",
  "voice": {
    "label": "Voice campaign",
    "hint": "Our team will call you on this number to complete your profile."
  },
  "form": {
    "label": "Form",
    "hint": "Participants fill the full profile online. Partial submissions are accepted."
  }
},
```

- [ ] **Step 2: Translate for hi.json**

```json
"registration_mode": {
  "field_label": "पंजीकरण मोड",
  "voice": {
    "label": "वॉयस अभियान",
    "hint": "हम प्रोफ़ाइल पूरी करने के लिए इस नंबर पर आपको कॉल करेंगे।"
  },
  "form": {
    "label": "फ़ॉर्म",
    "hint": "प्रतिभागी ऑनलाइन पूरी प्रोफ़ाइल भरते हैं। आंशिक सबमिशन स्वीकार किए जाते हैं।"
  }
},
```

- [ ] **Step 3: Translate for kn.json**

```json
"registration_mode": {
  "field_label": "ನೋಂದಣಿ ಮೋಡ್",
  "voice": {
    "label": "ವಾಯ್ಸ್ ಅಭಿಯಾನ",
    "hint": "ನಿಮ್ಮ ಪ್ರೊಫೈಲ್ ಪೂರ್ಣಗೊಳಿಸಲು ನಾವು ಈ ಸಂಖ್ಯೆಗೆ ಕರೆ ಮಾಡುತ್ತೇವೆ."
  },
  "form": {
    "label": "ಫಾರ್ಮ್",
    "hint": "ಭಾಗವಹಿಸುವವರು ಆನ್‌ಲೈನ್‌ನಲ್ಲಿ ಪೂರ್ಣ ಪ್ರೊಫೈಲ್ ಭರ್ತಿ ಮಾಡುತ್ತಾರೆ. ಭಾಗಶಃ ಸಲ್ಲಿಕೆಗಳನ್ನು ಸ್ವೀಕರಿಸಲಾಗುತ್ತದೆ."
  }
},
```

- [ ] **Step 4: Add `create_link.field_registration_mode` key + remove old `field_submission_mode` + related**

In the `onboarding.create_link.*` namespace, find and replace:

```json
// Remove:
"field_submission_mode": "...",
"submission_mode_full_label": "...",
"submission_mode_full_hint": "...",
"submission_mode_account_only_label": "...",
"submission_mode_account_only_hint": "...",

// Add:
"field_registration_mode": "Registration mode",
```

Add the translated variant in hi.json + kn.json.

- [ ] **Step 5: Remove the `profile.public_reg.account_only.*` block (now superseded by `registration_mode.*`)**

Search for `"account_only": {` under `profile.public_reg` and remove that block + its content in all three locales.

Update MinimalIdentityForm's i18n scope reference accordingly (it used `profile.public_reg.account_only`). Replace with a per-key lookup against the top-level `registration_mode` namespace. But this is tricky — the form has labels like `name_label`, `phone_label`, etc. Keep those under `profile.public_reg.account_only` (rename to e.g. `profile.public_reg.minimal_form`). Cleaner: rename the existing scope to match the new feature:

```json
// In en.json, rename:
"profile.public_reg.account_only" → "profile.public_reg.minimal_form"
```

Update `MinimalIdentityForm.tsx`'s scope:

```ts
const t = useTranslations('profile.public_reg.minimal_form');
```

Match hi + kn.

- [ ] **Step 6: Verify i18n parity test passes**

```bash
pnpm --filter @aggregator-dpg/web test -- messages 2>&1 | tail -5
# expect: PASS — all three locales same keys
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/i18n/messages/ apps/web/src/app/\[org\]/\[slug\]/MinimalIdentityForm.tsx
git commit -m "i18n: registration_mode namespace + rename minimal_form scope"
```

---

## Task 14: Cleanup pass — search for any straggling submission_mode references

- [ ] **Step 1: Grep**

```bash
grep -rn "submission_mode\|submissionMode\|SUBMISSION_MODE" apps packages config --include="*.ts" --include="*.tsx" --include="*.json" --include="*.yaml" --include="*.sql" 2>/dev/null | grep -v ".test.ts.backup" | grep -v "^docs/" | head -20
# expect: empty
```

- [ ] **Step 2: If results, fix each**

For each remaining reference, decide:

- Variable name in a function body → rename
- Comment → update wording
- JSON key → migrate

Re-run the grep until empty.

- [ ] **Step 3: Run full sweep**

```bash
pnpm -w lint 2>&1 | tail -3
pnpm -w typecheck 2>&1 | tail -3
pnpm -w test 2>&1 | tail -5
pnpm dep-check 2>&1 | tail -3
```

All four must be green.

- [ ] **Step 4: Commit if any fixes**

```bash
git add -A
git commit -m "chore: remove remaining submission_mode references"
```

(Skip if nothing changed.)

---

## Task 15: Push + update PR #401

- [ ] **Step 1: Push**

```bash
git push origin feat/account-only-onboarding-mode
```

- [ ] **Step 2: Update PR #401 title + body**

```bash
gh pr edit 401 --repo Blue-Dots-Economy/aggregator-dpg \
  --title "feat: per-link registration_mode (voice + form, config-driven)" \
  --body-file - <<'EOF'
## Summary

Per-link `registration_mode` toggle. Two modes ship: `voice` (account-only form + voice-call hint) and `form` (full RJSF + silent partial-accept). Mode → form-shape mapping lives in per-network `aggregator.config.yaml` under `registration_modes:`. Supersedes the prior `submission_mode` commits on this branch.

Spec: `docs/superpowers/specs/2026-06-09-registration-mode-design.md`
Plan: `docs/superpowers/plans/2026-06-09-registration-mode.md`

## Key decisions

1. Mode names: `voice` / `form` (admin-facing channels, not data shapes).
2. Mapping in config (per-network `aggregator.config.yaml`), not DB.
3. Voice mode is form-only — voice call is out-of-band, no auto-dispatcher.
4. Form mode silently accepts partial submissions (no "Submit identity now" checkbox).
5. Mode is immutable post-creation; existing local `submission_mode` rows dropped cleanly.

## What landed

- `packages/network-config` Zod schema for `registration_modes` block
- `config/purple_dot/aggregator.config.yaml` declares voice + form
- DB migration `0015_registration_mode.sql` (drop submission_mode, add registration_mode)
- `apps/api/src/services/registration-mode/` resolver + tests
- Admin create validates mode key against live config; INVALID_REGISTRATION_MODE on unknown
- Public resolve returns `registration_mode` + resolved `submission_shape` + `public_hint_i18n_key`
- Public submit branches on resolved shape; silent partial for `account_and_profile`
- Web admin dropdown sourced from live config
- Web public view branches on `submissionShape`; partial checkbox removed
- i18n: `registration_mode.*` namespace in en/hi/kn

## Status

Draft until reviewer signs off on naming + scope.

🤖 Generated with [Claude Code](https://claude.ai/code)
EOF
```

---

## Out of scope (deferred per spec)

- Auto-wiring `completion_actions[]` when voice mode is chosen
- Real outbound vendor adapters
- Additional channels (sms, whatsapp, kiosk)
- Per-mode admin permissions
