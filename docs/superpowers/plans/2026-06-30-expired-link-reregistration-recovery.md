# Expired-Link & Re-Registration Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `pending` or rejected (`inactive`) aggregator registration reclaimable on resubmit instead of dead-ending at `409 USER_EXISTS`/`PHONE_EXISTS` after the approval link expires, and give the reviewer a one-click "resend approval link" path.

**Architecture:** Build directly on today's flat registration + signed-token approval flow (no new engine, no feature flag). The DB column `aggregators.status` is the authority that distinguishes a genuine duplicate (`active`/`retired`) from a reclaimable record (`pending`/`inactive`). The submit handler branches on it; a new resend endpoint re-mints + re-emails for an existing pending record; the expired-link confirmation page surfaces that endpoint as a button. A service-auth cleanup endpoint prunes stale pending records (DB row + Keycloak user) so the email/phone namespace stays free.

**Tech Stack:** TypeScript, Fastify (`apps/api`), Drizzle/Postgres, Keycloak admin (`idp-admin`), `jose` JWTs, Vitest. No new dependencies.

## Global Constraints

- **TypeScript only**; pnpm + Turbo monorepo. Node ≥ 24.
- **This plan is flag-independent.** It does NOT read or introduce `ORG_HIERARCHY_ENABLED`. It fixes the existing flat flow and ships standalone (spec §13.3).
- **No signalstack schema change. No new DB migration.** Recovery reuses existing columns (`aggregators.status`, `updated_at`).
- Service-boundary methods return `Result`/`StoreResult`/`IdpResult` — **never throw across a boundary**. Route handlers throw `httpError(<CODE>)` (Fastify error path) as the existing code does.
- Structured logging via `req.log.child({ operation })` (pino) with `status` (`success`/`failure`/`skipped`) and `latency_ms` for external calls (rule: logging-observability). No bare `console.log`.
- No domain/env value hardcoded — read from `config` / env at startup (rule: configuration-discipline).
- TSDoc on every new public function (rule: code-documentation).
- Tests: Vitest, in-memory fakes via `_setX` injection (see `apps/api/src/routes/aggregator-registrations.test.ts`). No real network/DB. Target ≥ 70% line coverage.
- Conventional Commits; **never** `--no-verify`. Commit after every green step.

---

## File Structure

| File                                                   | Responsibility                                                                                                         | Change        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------- |
| `apps/api/src/services/registration-notify.ts`         | Mint approve/reject tokens + send the admin-review email. Shared by submit, reclaim, and resend.                       | **Create**    |
| `apps/api/src/routes/aggregator-registrations.ts`      | Submit handler — add status-distinguishing uniqueness + reclaim branch; delegate email to the new helper.              | Modify        |
| `apps/api/src/services/approval-token.ts`              | Add `allowExpired` option to `verifyApprovalToken` so the resend path can accept an expired-but-signature-valid token. | Modify        |
| `apps/api/src/views/approval-pages.ts`                 | Add an optional resend action button to `renderResultPage`.                                                            | Modify        |
| `apps/api/src/routes/aggregator-approvals.ts`          | Add resend endpoint; surface resend button on the expired-link page; add the stale-pending cleanup endpoint.           | Modify        |
| `apps/api/src/errors/codes.ts`                         | Add `LINK_EXPIRED_RESENT` is not needed; reuse existing codes. (No change unless a step says so.)                      | —             |
| `apps/api/src/routes/aggregator-registrations.test.ts` | Reclaim tests.                                                                                                         | Modify        |
| `apps/api/src/routes/aggregator-approvals.test.ts`     | Resend + expired-page + cleanup tests.                                                                                 | Modify        |
| `apps/api/src/services/approval-token.test.ts`         | `allowExpired` unit tests.                                                                                             | Create/Modify |
| `apps/api/src/views/approval-pages.test.ts`            | Resend-button render test.                                                                                             | Create/Modify |

---

## Reference: current behaviour (verified in code)

- **Status enum** (`packages/db-schema/src/schema.ts`): `aggregator_status = ['pending','active','inactive','retired']`. Approval reject sets `inactive`; approve sets `active`. So **"rejected" == `inactive`**.
- **Submit** (`aggregator-registrations.ts`): checks `findByContactEmail` → `USER_EXISTS`, `findByContactPhone` → `PHONE_EXISTS`, then KC `findByEmail`/`findByAttribute(phoneNumber)` → same codes. Creates row (`createAggregatorWithSlug`), profile stub, disabled KC user (`decision_made='pending'`), mints 2 tokens, emails `parseAdminEmails()`. Returns **201**.
- **Approval GET** (`aggregator-approvals.ts:63-147`): verifies token; on `!verified.ok` renders error page with `tokenErrorMessage(code)` — for `EXPIRED` the copy is "This approval link has expired. Ask the applicant to resubmit." (the dead-end).
- **`verifyApprovalToken`** (`approval-token.ts`): returns `{ok:true, aggregatorId, intent}` or `{ok:false, error:{code:'EXPIRED'|'INVALID'|'MALFORMED'}}`. On `EXPIRED` it carries no id.
- **Store** (`aggregator-store/interface.ts`): `findByContactEmail`, `findByContactPhone`, `update(id, patch)` (patch supports `status`, `updatedBy`, etc.), `updateStatus`, `deleteById`. All return `StoreResult`.
- **IdP** (`idp-admin/interface.ts`): `findByEmail`, `setAttributes`, `setUserDecision`, `disableUser`, `deleteUser`, `createUser`. No group ops (not needed here).
- **Test harness**: `buildApp()` + `_setAggregatorStore`/`_setAggregatorProfileStore`/`_setIdpAdmin`/`_setMailer`/`_setAccessTokenVerifier`; `mailer.outbox` captures sent mail.

---

## Task 1: Extract admin-review notifier + add status-distinguishing reclaim

**Files:**

- Create: `apps/api/src/services/registration-notify.ts`
- Modify: `apps/api/src/routes/aggregator-registrations.ts`
- Test: `apps/api/src/routes/aggregator-registrations.test.ts`

**Interfaces:**

- Produces: `sendAdminReviewEmail(input: AdminReviewNotifyInput, log: FastifyBaseLogger): Promise<void>` where
  `AdminReviewNotifyInput = { aggregatorId: string; applicantName: string; applicantEmail: string; applicantPhone: string }`.
  Mints approve+reject JWTs, sends the admin-review email to `parseAdminEmails()`. Throws `httpError('TOKEN_MINT_FAILED')` if minting fails; logs (warn) and continues if mail delivery fails.
- Produces: `isReclaimable(status: AggregatorStatus): boolean` (exported from the route module for tests) — `true` for `'pending'` and `'inactive'`.
- Consumes: existing `mintApprovalToken`, `formatApprovalTtl`, `renderAdminReview`, `getMailer`, `config`.

- [ ] **Step 1: Write the failing reclaim test (pending row → refresh, 200, second email)**

Add to `apps/api/src/routes/aggregator-registrations.test.ts` inside the existing `describe`:

```typescript
async function seedPending(overrides?: { status?: 'pending' | 'inactive' | 'active' }) {
  const created = await aggregatorStore.create({
    orgSlug: 'trrain-aaaa',
    actorType: 'aggregator',
    name: 'TRRAIN',
    type: 'seeker',
    url: null,
    contact: {
      name: 'Asha Kumari',
      phone: '+919876543210',
      email: 'asha@trrain.org',
    },
    locations: [],
    consent: validBody.consent,
    createdBy: 'self',
    updatedBy: 'self',
  });
  if (!created.ok) throw new Error('seed failed');
  const id = created.value.id;
  if (overrides?.status && overrides.status !== 'pending') {
    await aggregatorStore.updateStatus(id, overrides.status, 'admin');
  }
  await idp.createUser({
    email: 'asha@trrain.org',
    phone: '+919876543210',
    enabled: false,
    attributes: {
      aggregator_id: id,
      aggregator_type: 'seeker',
      phoneNumber: '+919876543210',
      decision_made: overrides?.status === 'inactive' ? 'rejected' : 'pending',
    },
  });
  return id;
}

it('refreshes a pending registration on resubmit instead of 409', async () => {
  const id = await seedPending();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/aggregator-registrations/create',
    headers: AUTH_HEADER,
    payload: validBody,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { aggregator_id: string; status: string };
  expect(body.aggregator_id).toBe(id);
  expect(body.status).toBe('pending');
  // A fresh admin-review email was re-sent.
  expect(mailer.outbox.length).toBe(1);
  expect(mailer.outbox[0]?.html).toContain('intent=approve');
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-registrations.test.ts -t "refreshes a pending"`
Expected: FAIL — current handler returns `409`, not `200`.

- [ ] **Step 3: Create the notifier helper**

Create `apps/api/src/services/registration-notify.ts`:

```typescript
/**
 * Admin-review notification for the aggregator registration flow.
 *
 * Belongs to `@aggregator-dpg/api`. Mints the approve/reject JWT pair and
 * sends the reviewer email. Shared by the initial submit, the resubmit
 * (reclaim) path, and the explicit "resend approval link" endpoint so the
 * three surfaces stay byte-for-byte identical.
 */

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { mintApprovalToken, formatApprovalTtl } from './approval-token.js';
import { renderAdminReview } from './email-templates/index.js';
import { getMailer } from './mailer/index.js';
import { httpError } from '../errors/http-error.js';

/** Inputs needed to render and deliver the admin-review email. */
export interface AdminReviewNotifyInput {
  aggregatorId: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
}

/**
 * Parse the comma-separated `ADMIN_EMAILS` env value into a clean array.
 * Tolerates wrapping quotes and stray whitespace; falls back to a safe
 * default when unset.
 *
 * @returns The reviewer recipient list (never empty).
 */
export function parseAdminEmails(): string[] {
  let raw = (process.env.ADMIN_EMAILS ?? '').trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  const list = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ['admin@bluedots.local'];
}

/**
 * Mint a fresh approve/reject token pair for a registration and email the
 * configured reviewers a review link.
 *
 * @param input - Registration id + applicant identity for the email body.
 * @param log - Request-scoped logger for delivery diagnostics.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if either JWT cannot be minted.
 */
export async function sendAdminReviewEmail(
  input: AdminReviewNotifyInput,
  log: FastifyBaseLogger,
): Promise<void> {
  let approveToken: string;
  let rejectToken: string;
  try {
    const ttlSec = config.APPROVAL_TOKEN_TTL_SECONDS;
    approveToken = (
      await mintApprovalToken({ aggregatorId: input.aggregatorId, intent: 'approve', ttlSec })
    ).token;
    rejectToken = (
      await mintApprovalToken({ aggregatorId: input.aggregatorId, intent: 'reject', ttlSec })
    ).token;
  } catch (err) {
    throw httpError('TOKEN_MINT_FAILED', { cause: err });
  }

  const decisionBase = `${config.PUBLIC_API_URL}/admin/v1/aggregator-registrations/read/${input.aggregatorId}`;
  const reviewMail = renderAdminReview({
    registrationId: input.aggregatorId,
    applicantName: input.applicantName,
    applicantEmail: input.applicantEmail,
    applicantPhone: input.applicantPhone,
    association: input.applicantName,
    aggregatorType: 'aggregator',
    approveUrl: `${decisionBase}?token=${encodeURIComponent(approveToken)}&intent=approve`,
    rejectUrl: `${decisionBase}?token=${encodeURIComponent(rejectToken)}&intent=reject`,
    submittedAt: new Date(),
    expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
  });

  const mailResult = await getMailer().send({
    to: parseAdminEmails(),
    subject: reviewMail.subject,
    html: reviewMail.html,
    text: reviewMail.text,
  });
  if (!mailResult.ok) {
    log.warn(
      {
        operation: 'registration-notify.sendAdminReviewEmail',
        status: 'failure',
        sub_operation: 'mailer.send',
        code: mailResult.error.code,
        cause: mailResult.error.message,
      },
      'admin review email delivery failed — registration still recorded',
    );
  }
}
```

- [ ] **Step 4: Rewire the submit handler to use the helper and add the reclaim branch**

In `apps/api/src/routes/aggregator-registrations.ts`:

1. Replace the token-mint + admin-email block (current lines ~258-303) and remove the now-duplicated local `parseAdminEmails` (lines ~456-469) with a single call to the helper. Add imports at top:

```typescript
import { sendAdminReviewEmail, parseAdminEmails } from '../services/registration-notify.js';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
```

(Remove the old local `parseAdminEmails` function and the `renderAdminReview`, `mintApprovalToken`, `formatApprovalTtl` imports that are no longer used directly.)

2. Add the predicate near the bottom of the file:

```typescript
/**
 * Whether an existing registration in this status may be reclaimed by a
 * resubmission. `pending` (awaiting a decision) and `inactive` (rejected)
 * records belong to the same applicant and are refreshed in place; `active`
 * and `retired` are live identities and must keep returning a duplicate error.
 *
 * @param status - The matched aggregator's lifecycle status.
 * @returns `true` when a resubmit should refresh rather than 409.
 */
export function isReclaimable(status: AggregatorStatus): boolean {
  return status === 'pending' || status === 'inactive';
}
```

3. Replace the email-uniqueness block so that a reclaimable match branches to refresh. Find the current block:

```typescript
if (dbEmail.value !== null) {
  throw httpError('USER_EXISTS', { fields: { email: contact.email } });
}
```

Replace with:

```typescript
if (dbEmail.value !== null) {
  const existing = dbEmail.value;
  if (!isReclaimable(existing.status)) {
    throw httpError('USER_EXISTS', { fields: { email: contact.email } });
  }
  // Reclaim path: same applicant resubmitting against a pending/rejected
  // record (e.g. after the approval link expired). Refresh the row +
  // KC user in place and re-mint a fresh approval link.
  const dbPhone = await aggregatorStore.findByContactPhone(phoneE164);
  if (!dbPhone.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(dbPhone.error.message),
      fields: { sub_operation: 'aggregatorStore.findByContactPhone' },
    });
  }
  if (dbPhone.value !== null && dbPhone.value.id !== existing.id) {
    // The new phone belongs to a different record — genuine conflict.
    throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
  }

  const updated = await aggregatorStore.update(existing.id, {
    name: body.name,
    type: body.type,
    url: body.url ?? null,
    contact,
    locations: body.locations,
    consent: serverConsent,
    status: 'pending',
    updatedBy: 'self',
  });
  if (!updated.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(updated.error.message),
      fields: { sub_operation: 'aggregatorStore.update', reclaim: true },
    });
  }

  // Reuse the existing (still-disabled) KC user; refresh its attributes
  // and reset the decision gate to pending. Recreate it only if drift
  // left the DB row without a matching KC user.
  const kcExisting = await idp.findByEmail(contact.email);
  if (!kcExisting.ok) {
    throw httpError('IDP_UNAVAILABLE', {
      cause: kcExisting.error,
      fields: { sub_operation: 'idp.findByEmail', reclaim: true },
    });
  }
  if (kcExisting.value !== null) {
    const kcId = kcExisting.value.id;
    await idp.setAttributes(kcId, {
      [KC_ATTR.AGGREGATOR_TYPE]: body.type,
      [KC_ATTR.PHONE_NUMBER]: phoneE164,
    });
    await idp.setUserDecision(kcId, 'pending');
    await idp.disableUser(kcId);
  } else {
    const { firstName, lastName } = splitName(contact.name);
    const recreated = await idp.createUser({
      email: contact.email,
      username: contact.email,
      phone: phoneE164,
      enabled: false,
      firstName,
      lastName,
      attributes: {
        [KC_ATTR.AGGREGATOR_ID]: existing.id,
        [KC_ATTR.AGGREGATOR_TYPE]: body.type,
        [KC_ATTR.PHONE_NUMBER]: phoneE164,
        [KC_ATTR.DECISION_MADE]: 'pending',
      },
    });
    if (!recreated.ok) {
      throw httpError('IDP_UNAVAILABLE', {
        cause: recreated.error,
        fields: { sub_operation: 'idp.createUser', reclaim: true },
      });
    }
  }

  await sendAdminReviewEmail(
    {
      aggregatorId: existing.id,
      applicantName: body.name,
      applicantEmail: contact.email,
      applicantPhone: phoneE164,
    },
    log,
  );

  log.info(
    {
      status: 'success',
      latency_ms: Date.now() - start,
      aggregator_id: existing.id,
      reclaim: true,
    },
    'aggregator registration resubmitted (reclaimed pending record)',
  );

  return reply.status(200).send({
    aggregator_id: existing.id,
    org_slug: existing.orgSlug,
    status: 'pending',
    message: 'Registration re-submitted. A fresh approval link has been sent for review.',
  });
}
```

4. Replace the new-registration token-mint + email block (the old `try { ... mintApprovalToken ... } ... mailer.send(...)`) with:

```typescript
await sendAdminReviewEmail(
  {
    aggregatorId,
    applicantName: body.name,
    applicantEmail: contact.email,
    applicantPhone: phoneE164,
  },
  log,
);
```

(`serverConsent`, `idp`, `aggregatorStore`, `mailer`, `KC_ATTR`, `splitName` are all already in scope above their use. `mailer` may now be unused in the handler — remove its `getMailer()` binding if so.)

- [ ] **Step 5: Run the reclaim test; verify it passes**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-registrations.test.ts -t "refreshes a pending"`
Expected: PASS.

- [ ] **Step 6: Add the remaining reclaim tests**

```typescript
it('reactivates a rejected (inactive) registration on resubmit', async () => {
  const id = await seedPending({ status: 'inactive' });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/aggregator-registrations/create',
    headers: AUTH_HEADER,
    payload: validBody,
  });
  expect(res.statusCode).toBe(200);
  const stored = await aggregatorStore.findById(id);
  if (stored.ok) expect(stored.value?.status).toBe('pending');
  const kc = await idp.findByEmail(validBody.contact.email);
  if (kc.ok && kc.value) {
    expect(kc.value.enabled).toBe(false);
    expect(kc.value.attributes?.decision_made?.[0]).toBe('pending');
  }
});

it('still returns 409 when the email belongs to an active aggregator', async () => {
  await seedPending({ status: 'active' });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/aggregator-registrations/create',
    headers: AUTH_HEADER,
    payload: validBody,
  });
  expect(res.statusCode).toBe(409);
  expect((res.json() as { error: { code: string } }).error.code).toBe('USER_EXISTS');
});

it('rejects reclaim when the new phone is taken by a different record', async () => {
  await seedPending(); // asha@trrain.org / +919876543210, pending
  // A different ACTIVE aggregator already owns the phone the resubmit carries.
  const other = await aggregatorStore.create({
    orgSlug: 'other-bbbb',
    actorType: 'aggregator',
    name: 'Other',
    type: 'seeker',
    url: null,
    contact: { name: 'X', phone: '+911111111111', email: 'x@other.org' },
    locations: [],
    consent: validBody.consent,
    createdBy: 'self',
    updatedBy: 'self',
  });
  if (other.ok) await aggregatorStore.updateStatus(other.value.id, 'active', 'admin');
  const res = await app.inject({
    method: 'POST',
    url: '/v1/aggregator-registrations/create',
    headers: AUTH_HEADER,
    payload: { ...validBody, contact: { ...validBody.contact, phone: '+911111111111' } },
  });
  expect(res.statusCode).toBe(409);
  expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_EXISTS');
});
```

- [ ] **Step 7: Run the full registration test file**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-registrations.test.ts`
Expected: PASS (the existing `creates an aggregator` test still returns 201; new tests pass).

- [ ] **Step 8: Typecheck + lint**

Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm --filter @aggregator-dpg/api lint`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/registration-notify.ts apps/api/src/routes/aggregator-registrations.ts apps/api/src/routes/aggregator-registrations.test.ts
git commit -m "feat(api): reclaim pending/rejected registration on resubmit instead of 409"
```

---

## Task 2: `verifyApprovalToken` accepts expired tokens for resend

**Files:**

- Modify: `apps/api/src/services/approval-token.ts`
- Test: `apps/api/src/services/approval-token.test.ts`

**Interfaces:**

- Produces: `verifyApprovalToken(token: string, opts?: { allowExpired?: boolean }): Promise<VerifyResult>`. With `allowExpired: true`, an expired-but-signature-valid token resolves `{ ok: true, aggregatorId, intent }` instead of `{ ok: false, error: { code: 'EXPIRED' } }`. Signature/issuer/audience failures still error. Default behaviour (no opts) is unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/approval-token.test.ts` (or add to it if present):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import { mintApprovalToken, verifyApprovalToken, _resetTokenKey } from './approval-token.js';

describe('verifyApprovalToken allowExpired', () => {
  beforeEach(() => {
    _resetTokenKey();
    process.env.APPROVAL_TOKEN_SECRET = 'k'.repeat(48);
  });

  async function mintExpired(): Promise<string> {
    const key = new TextEncoder().encode(process.env.APPROVAL_TOKEN_SECRET);
    return new SignJWT({ intent: 'approve' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('agg-1')
      .setIssuer('aggregator-api')
      .setAudience('aggregator-admin')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);
  }

  it('rejects an expired token by default', async () => {
    const t = await mintExpired();
    const r = await verifyApprovalToken(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('EXPIRED');
  });

  it('accepts an expired token when allowExpired is set', async () => {
    const t = await mintExpired();
    const r = await verifyApprovalToken(t, { allowExpired: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.aggregatorId).toBe('agg-1');
      expect(r.intent).toBe('approve');
    }
  });

  it('still rejects a tampered token even with allowExpired', async () => {
    const t = (await mintApprovalToken({ aggregatorId: 'agg-2', intent: 'approve' })).token;
    const tampered = t.slice(0, -3) + 'aaa';
    const r = await verifyApprovalToken(tampered, { allowExpired: true });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it; verify the allowExpired test fails**

Run: `pnpm --filter @aggregator-dpg/api test -- approval-token.test.ts`
Expected: FAIL — `verifyApprovalToken` ignores the second argument; the "accepts an expired token" case returns `EXPIRED`.

- [ ] **Step 3: Implement `allowExpired`**

In `apps/api/src/services/approval-token.ts`:

1. Extend the import: `import { SignJWT, jwtVerify, decodeJwt, errors as joseErrors } from 'jose';`
2. Replace the `verifyApprovalToken` signature + the `JWTExpired` branch:

```typescript
export async function verifyApprovalToken(
  token: string,
  opts: { allowExpired?: boolean } = {},
): Promise<VerifyResult> {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, error: { code: 'MALFORMED', message: 'token is not a JWT' } };
  }
  try {
    const { payload } = await jwtVerify(token, getKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALG],
    });
    if (!payload.sub) {
      return { ok: false, error: { code: 'INVALID', message: 'missing sub claim' } };
    }
    const intent = payload.intent;
    if (intent !== 'approve' && intent !== 'reject') {
      return { ok: false, error: { code: 'INVALID', message: 'bad intent claim' } };
    }
    return { ok: true, aggregatorId: payload.sub, intent };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      if (opts.allowExpired) {
        // jose validates the JWS signature BEFORE the `exp` claim, so a
        // JWTExpired throw guarantees the signature was genuine. Decoding the
        // (unverified) payload here is therefore safe — used only by the
        // resend path to recover the aggregator id from a stale link.
        const payload = decodeJwt(token);
        const intent = payload.intent;
        if (!payload.sub || (intent !== 'approve' && intent !== 'reject')) {
          return { ok: false, error: { code: 'INVALID', message: 'bad claims in expired token' } };
        }
        return { ok: true, aggregatorId: payload.sub, intent };
      }
      return { ok: false, error: { code: 'EXPIRED', message: 'token expired' } };
    }
    if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JWSInvalid) {
      return { ok: false, error: { code: 'MALFORMED', message: err.message } };
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { ok: false, error: { code: 'INVALID', message: 'signature failed' } };
    }
    return {
      ok: false,
      error: { code: 'INVALID', message: err instanceof Error ? err.message : 'verify failed' },
    };
  }
}
```

- [ ] **Step 4: Run; verify pass**

Run: `pnpm --filter @aggregator-dpg/api test -- approval-token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/approval-token.ts apps/api/src/services/approval-token.test.ts
git commit -m "feat(api): verifyApprovalToken supports allowExpired for resend path"
```

---

## Task 3: Resend endpoint + resend button on the expired-link page

**Files:**

- Modify: `apps/api/src/views/approval-pages.ts`
- Modify: `apps/api/src/routes/aggregator-approvals.ts`
- Test: `apps/api/src/views/approval-pages.test.ts`, `apps/api/src/routes/aggregator-approvals.test.ts`

**Interfaces:**

- Produces (route): `POST /admin/v1/aggregator-registrations/resend/:id` with body `{ token: string }`. Verifies the token with `allowExpired: true`, confirms `token.sub === :id`, requires the record to still be `pending`, then re-mints + re-emails via `sendAdminReviewEmail`. Returns an HTML result page (200 success / 200 info if already decided / 400 invalid).
- Produces (view): `ResultPageVars` gains optional `action?: { url: string; token: string; label: string }`; when present `renderResultPage` renders a POST form button alongside the portal CTA.
- Consumes: `verifyApprovalToken(token, { allowExpired: true })` (Task 2), `sendAdminReviewEmail` (Task 1), `loadAggregatorAndUser` (existing in `aggregator-approvals.ts`).

- [ ] **Step 1: Write the failing view test**

Create `apps/api/src/views/approval-pages.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { renderResultPage } from './approval-pages.js';

describe('renderResultPage action button', () => {
  it('omits the resend form when no action is given', () => {
    const html = renderResultPage({ status: 'error', title: 'Invalid link', message: 'x' });
    expect(html).not.toContain('name="token"');
  });

  it('renders a resend form POSTing the token when action is given', () => {
    const html = renderResultPage({
      status: 'error',
      title: 'Link expired',
      message: 'x',
      action: {
        url: 'https://api.local/admin/v1/aggregator-registrations/resend/agg-1',
        token: 'tok-123',
        label: 'Resend approval link',
      },
    });
    expect(html).toContain(
      'action="https://api.local/admin/v1/aggregator-registrations/resend/agg-1"',
    );
    expect(html).toContain('value="tok-123"');
    expect(html).toContain('Resend approval link');
  });
});
```

- [ ] **Step 2: Run; verify fail**

Run: `pnpm --filter @aggregator-dpg/api test -- approval-pages.test.ts`
Expected: FAIL — `action` unsupported; the second test's assertions miss.

- [ ] **Step 3: Add the optional action to `renderResultPage`**

In `apps/api/src/views/approval-pages.ts`, extend the interface and the CTA row:

```typescript
export interface ResultPageVars {
  status: 'success' | 'error' | 'info';
  title: string;
  message: string;
  /**
   * Optional secondary action rendered as a POST form button (e.g. the
   * "resend approval link" affordance on the expired-link page). Posts a
   * single hidden `token` field to `url`.
   */
  action?: { url: string; token: string; label: string };
  brand?: PageBrand;
}
```

In `renderResultPage`, change the `result-cta-row` block to append the action form when present:

```typescript
        <div class="result-cta-row">
          <a class="result-cta" href="${escape(portalUrl)}">
            Open ${escape(brand.short_name)} Portal
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 5l7 7-7 7"/></svg>
          </a>
          ${
            v.action
              ? `<form method="POST" action="${escape(v.action.url)}" style="margin:0;display:inline;">
                   <input type="hidden" name="token" value="${escape(v.action.token)}" />
                   <button type="submit" class="btn-secondary">${escape(v.action.label)}</button>
                 </form>`
              : ''
          }
        </div>
```

- [ ] **Step 4: Run the view test; verify pass**

Run: `pnpm --filter @aggregator-dpg/api test -- approval-pages.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing resend route test**

Add to `apps/api/src/routes/aggregator-approvals.test.ts` (mirror its existing setup — same `_setX` fakes). First a helper that seeds a pending aggregator + KC user and returns `{ id, token }` where `token` is a valid approve token, plus an `mintExpired(id)` helper like Task 2 but with the real `mintApprovalToken`/manual expiry:

```typescript
it('resend re-mints and re-emails for a pending record (expired token accepted)', async () => {
  const { id } = await seedPendingAggregator(); // existing/new helper in this file
  const expired = await mintExpiredApproveToken(id); // iat/exp in the past, valid signature
  const res = await app.inject({
    method: 'POST',
    url: `/admin/v1/aggregator-registrations/resend/${id}`,
    payload: { token: expired },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('text/html');
  expect(mailer.outbox.length).toBeGreaterThanOrEqual(1);
  expect(mailer.outbox.at(-1)?.html).toContain('intent=approve');
});

it('resend rejects a malformed token with 400', async () => {
  const { id } = await seedPendingAggregator();
  const res = await app.inject({
    method: 'POST',
    url: `/admin/v1/aggregator-registrations/resend/${id}`,
    payload: { token: 'not-a-jwt' },
  });
  expect(res.statusCode).toBe(400);
});

it('resend shows already-decided for an active record', async () => {
  const { id } = await seedPendingAggregator();
  await aggregatorStore.updateStatus(id, 'active', 'admin');
  const expired = await mintExpiredApproveToken(id);
  const res = await app.inject({
    method: 'POST',
    url: `/admin/v1/aggregator-registrations/resend/${id}`,
    payload: { token: expired },
  });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('already');
});
```

- [ ] **Step 6: Run; verify fail**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-approvals.test.ts -t "resend"`
Expected: FAIL — route 404 (endpoint not registered yet).

- [ ] **Step 7: Implement the resend endpoint + expired-page button**

In `apps/api/src/routes/aggregator-approvals.ts`:

1. Add import: `import { sendAdminReviewEmail } from '../services/registration-notify.js';`
2. In the GET handler, replace the single `!verified.ok` block with an expired-aware branch:

```typescript
const verified = await verifyApprovalToken(token);
if (!verified.ok) {
  const isExpired = verified.error.code === 'EXPIRED';
  return sendHtml(
    reply,
    400,
    renderResultPage({
      status: 'error',
      title: isExpired ? 'Link expired' : 'Invalid link',
      message: tokenErrorMessage(verified.error.code),
      action: isExpired
        ? {
            url: `${config.PUBLIC_API_URL}/admin/v1/aggregator-registrations/resend/${aggregatorId}`,
            token,
            label: 'Resend approval link',
          }
        : undefined,
    }),
  );
}
```

3. Update `tokenErrorMessage` `EXPIRED` copy to point at the button:

```typescript
    case 'EXPIRED':
      return 'This approval link has expired. Use the button below to email a fresh link to the reviewers.';
```

4. Register the resend route (after the decision POST route, before the closing brace of `registerAggregatorApprovalRoutes`):

```typescript
app.post(
  '/admin/v1/aggregator-registrations/resend/:id',
  {
    schema: {
      tags: ['aggregator-approvals'],
      summary: 'Resend a fresh approval link for a pending registration',
      description:
        'Re-mints the approve/reject token pair and re-emails the reviewers for a still-pending registration. Accepts an expired-but-signature-valid token as proof the caller held a legitimate link. Returns an HTML result page.',
      params: ApprovalParamsSchema,
    },
  },
  async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const log = req.log.child({ operation: 'aggregator-registration.resend' });
    const aggregatorId = req.params.id;
    const body = (req.body ?? {}) as { token?: string };
    const token = typeof body.token === 'string' ? body.token : '';

    const verified = await verifyApprovalToken(token, { allowExpired: true });
    if (!verified.ok) {
      return sendHtml(
        reply,
        400,
        renderResultPage({
          status: 'error',
          title: 'Invalid link',
          message: tokenErrorMessage(verified.error.code),
        }),
      );
    }
    if (verified.aggregatorId !== aggregatorId) {
      return sendHtml(
        reply,
        400,
        renderResultPage({
          status: 'error',
          title: 'Invalid link',
          message: 'Token does not match the requested aggregator.',
        }),
      );
    }

    const lookup = await loadAggregatorAndUser(aggregatorId);
    if (!lookup.ok) return sendHtml(reply, lookup.status, lookup.html);

    const prior = decisionFromStatus(lookup.aggregator.status);
    if (prior) {
      return sendHtml(reply, 200, renderResultPage(alreadyDecidedView(prior)));
    }

    await sendAdminReviewEmail(
      {
        aggregatorId,
        applicantName: lookup.aggregator.name,
        applicantEmail: lookup.aggregator.contact.email,
        applicantPhone: lookup.aggregator.contactPhone,
      },
      log,
    );

    log.info({ status: 'success', aggregator_id: aggregatorId }, 'approval link resent');
    return sendHtml(
      reply,
      200,
      renderResultPage({
        status: 'success',
        title: 'Approval link sent',
        message: 'A fresh approval link has been emailed to the reviewers.',
      }),
    );
  },
);
```

(`loadAggregatorAndUser`, `decisionFromStatus`, `alreadyDecidedView`, `sendHtml`, `tokenErrorMessage`, `ApprovalParamsSchema` already exist in this module.)

- [ ] **Step 8: Run the resend + expired-page tests; verify pass**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-approvals.test.ts`
Expected: PASS. Add/confirm a test asserting the GET expired-link page contains the resend form:

```typescript
it('expired approval link page offers a resend button', async () => {
  const { id } = await seedPendingAggregator();
  const expired = await mintExpiredApproveToken(id);
  const res = await app.inject({
    method: 'GET',
    url: `/admin/v1/aggregator-registrations/read/${id}?token=${encodeURIComponent(expired)}&intent=approve`,
  });
  expect(res.statusCode).toBe(400);
  expect(res.body).toContain(`/admin/v1/aggregator-registrations/resend/${id}`);
});
```

- [ ] **Step 9: Typecheck + lint + full api test**

Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm --filter @aggregator-dpg/api lint && pnpm --filter @aggregator-dpg/api test`
Expected: clean + green.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/views/approval-pages.ts apps/api/src/views/approval-pages.test.ts apps/api/src/routes/aggregator-approvals.ts apps/api/src/routes/aggregator-approvals.test.ts
git commit -m "feat(api): resend approval link endpoint + expired-page resend button"
```

---

## Task 4: Stale-pending cleanup endpoint (service-auth)

> Prunes registrations stuck `pending` past `token TTL + grace` so their email/phone free up in BOTH Postgres and Keycloak. Lives in the API (where the idp-admin client already is). The cron scheduler that calls it on an interval is a **follow-up** (worker has no idp-admin client today); document it but do not build the schedule here.

**Files:**

- Modify: `apps/api/src/config.ts` (grace window)
- Modify: `apps/api/src/routes/aggregator-registrations.ts` (or a new `apps/api/src/routes/aggregator-maintenance.ts` — create a new file to keep the submit route focused)
- Create: `apps/api/src/routes/aggregator-maintenance.ts`
- Test: `apps/api/src/routes/aggregator-maintenance.test.ts`
- Modify: `apps/api/src/app.ts` (register the new route module)

**Interfaces:**

- Consumes: `getAggregatorStore().list({ status: 'pending' })`, `findById`, `deleteById`; `getIdpAdmin().findByEmail`, `deleteUser`; `config.REGISTRATION_PENDING_GRACE_MS`, `config.APPROVAL_TOKEN_TTL_SECONDS`; `authenticateAny`.
- Produces: `POST /admin/v1/aggregator-registrations/cleanup-stale` → JSON `{ scanned: number; pruned: number; prunedIds: string[] }`.

- [ ] **Step 1: Add the grace-window config**

In `apps/api/src/config.ts` `ConfigSchema`, add (match the existing numeric-env pattern in that file):

```typescript
  /**
   * Extra grace beyond the approval-token TTL before a still-pending
   * registration is eligible for cleanup. Default 24h.
   */
  REGISTRATION_PENDING_GRACE_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
```

- [ ] **Step 2: Write the failing cleanup test**

Create `apps/api/src/routes/aggregator-maintenance.test.ts` (reuse the harness shape from `aggregator-registrations.test.ts`: `_setAggregatorStore`, `_setIdpAdmin`, `_setAccessTokenVerifier`, `buildApp`). Seed one fresh pending row and one stale pending row (stale = `updatedAt` far in the past). Assert only the stale one is pruned and its KC user deleted:

```typescript
it('prunes only stale pending registrations and their KC users', async () => {
  // fresh pending — should survive
  const fresh = await aggregatorStore.create(/* ...pending, email fresh@x.org... */);
  // stale pending — created then back-dated via the fake's seed/update
  const stale = await aggregatorStore.create(/* ...pending, email stale@x.org... */);
  if (stale.ok) await aggregatorStore.__setUpdatedAt?.(stale.value.id, new Date('2020-01-01'));
  await idp.createUser({ email: 'stale@x.org', enabled: false });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/v1/aggregator-registrations/cleanup-stale',
    headers: AUTH_HEADER,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { pruned: number; prunedIds: string[] };
  expect(body.pruned).toBe(1);
  if (stale.ok) expect(body.prunedIds).toContain(stale.value.id);
  const goneKc = await idp.findByEmail('stale@x.org');
  if (goneKc.ok) expect(goneKc.value).toBeNull();
  if (fresh.ok) {
    const survives = await aggregatorStore.findById(fresh.value.id);
    if (survives.ok) expect(survives.value).not.toBeNull();
  }
});
```

> NOTE: the in-memory `AggregatorStoreFake` may need a test-only `__setUpdatedAt(id, date)` (or a `seed()` that accepts `updatedAt`) to back-date a row. If it lacks one, add it to the fake under `aggregator-store` testing surface in this step (per testing rule: fakes own `seed()` helpers). Keep it test-only.

- [ ] **Step 3: Run; verify fail**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-maintenance.test.ts`
Expected: FAIL — route 404.

- [ ] **Step 4: Implement the cleanup route module**

Create `apps/api/src/routes/aggregator-maintenance.ts`:

```typescript
/**
 * Maintenance endpoints for the aggregator registration lifecycle.
 *
 * `@aggregator-dpg/api`. Houses the stale-pending-registration cleanup that
 * frees the email/phone namespace (Postgres row + Keycloak user) once an
 * approval link is well past its TTL and was never acted on. Invoked by an
 * out-of-band scheduler (cron/worker) using a service-account Bearer token.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

const CleanupResponseSchema = z
  .object({ scanned: z.number(), pruned: z.number(), prunedIds: z.array(z.string()) })
  .passthrough();

/**
 * Registers the stale-pending cleanup route. The cutoff is
 * `now - (APPROVAL_TOKEN_TTL_SECONDS*1000 + REGISTRATION_PENDING_GRACE_MS)`;
 * any `pending` registration last touched before the cutoff is deleted along
 * with its disabled Keycloak user.
 */
export async function registerAggregatorMaintenanceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/admin/v1/aggregator-registrations/cleanup-stale',
    {
      schema: {
        tags: ['aggregator-registrations'],
        summary: 'Prune registrations stuck pending past token expiry + grace',
        response: { 200: CleanupResponseSchema, ...errorResponses(401, 500, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'aggregator-registration.cleanup-stale' });
      const auth = await authenticateAny(req);
      if (!auth.ok) {
        throw httpError('UNAUTHORIZED', { detail: auth.error.message });
      }

      const store = getAggregatorStore();
      const idp = getIdpAdmin();
      const cutoffMs =
        Date.now() -
        (config.APPROVAL_TOKEN_TTL_SECONDS * 1000 + config.REGISTRATION_PENDING_GRACE_MS);
      const cutoff = new Date(cutoffMs);

      const page = await store.list({ status: 'pending', limit: 1000, offset: 0 });
      if (!page.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(page.error.message),
          fields: { sub_operation: 'aggregatorStore.list' },
        });
      }

      const stale = page.value.rows.filter((r) => r.updatedAt < cutoff);
      const prunedIds: string[] = [];
      for (const row of stale) {
        // Delete the KC user first so a partial failure leaves the DB row
        // (re-tried next pass) rather than an orphaned KC user.
        const kc = await idp.findByEmail(row.contactEmail);
        if (kc.ok && kc.value) {
          const del = await idp.deleteUser(kc.value.id);
          if (!del.ok) {
            log.warn(
              { status: 'skipped', aggregator_id: row.id, code: del.error.code },
              'skipped stale-pending prune — KC user delete failed',
            );
            continue;
          }
        }
        const deleted = await store.deleteById(row.id);
        if (!deleted.ok) {
          log.warn(
            { status: 'skipped', aggregator_id: row.id, code: deleted.error.code },
            'skipped stale-pending prune — DB delete failed',
          );
          continue;
        }
        prunedIds.push(row.id);
      }

      log.info(
        { status: 'success', scanned: page.value.rows.length, pruned: prunedIds.length },
        'stale-pending cleanup complete',
      );
      return reply
        .status(200)
        .send({ scanned: page.value.rows.length, pruned: prunedIds.length, prunedIds });
    },
  );
}
```

- [ ] **Step 5: Register the route module in `app.ts`**

In `apps/api/src/app.ts`, import and register alongside the other route registrations:

```typescript
import { registerAggregatorMaintenanceRoutes } from './routes/aggregator-maintenance.js';
// ... within the same block that calls registerAggregatorRegistrationRoutes(app):
await registerAggregatorMaintenanceRoutes(app);
```

- [ ] **Step 6: Run the cleanup test; verify pass**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-maintenance.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + lint + full api test + dep-check**

Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm --filter @aggregator-dpg/api lint && pnpm --filter @aggregator-dpg/api test && pnpm dep-check`
Expected: clean + green.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/routes/aggregator-maintenance.ts apps/api/src/routes/aggregator-maintenance.test.ts apps/api/src/app.ts apps/api/src/services/aggregator-store
git commit -m "feat(api): service-auth endpoint to prune stale pending registrations"
```

---

## Follow-up (not in this plan)

- **Cleanup scheduler.** A worker cron or external scheduler that calls `POST /admin/v1/aggregator-registrations/cleanup-stale` on an interval. Deferred because the worker has no idp-admin client today; wiring it (KC admin creds + a shared idp-admin package, or an HTTP service token from worker→API) is its own change. Grace cadence suggestion (spec §12.5): `token TTL + 24h`, already the config default.

---

## Self-Review

**Spec coverage (§7):**

- "make a `pending` record reclaimable" / "Match against `pending`/`rejected` → refresh + re-mint + re-send + reuse KC user" → **Task 1** (`isReclaimable`, reclaim branch). `active` still 409 → Task 1 Step 6.
- "lightweight resend approval link path (admin/owner-triggered, or auto on hitting an expired link)" → **Task 2** (`allowExpired`) + **Task 3** (resend endpoint + expired-page button).
- "periodic cleanup pruning records still pending past token expiry + grace — delete the pending aggregators row + disabled KC user" → **Task 4** (endpoint); scheduler deferred (documented).
- "independent of the hierarchy and ships standalone" → Global Constraints (no flag touched).

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". The one soft spot is Task 4 Step 2's `__setUpdatedAt` helper, which is explicitly called out to add to the fake if absent — concrete instruction, not a placeholder.

**Type consistency:** `isReclaimable(status: AggregatorStatus)`, `sendAdminReviewEmail(input, log)`, `verifyApprovalToken(token, { allowExpired })`, `ResultPageVars.action` are referenced with identical shapes across the tasks that consume them. `AggregatorStatus` values used (`pending`/`active`/`inactive`/`retired`) match the enum. `contactPhone`/`contactEmail`/`orgSlug` field names match `Aggregator` (store interface).
