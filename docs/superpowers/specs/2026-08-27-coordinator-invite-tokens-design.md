# Targeted coordinator invites — design

Registration stops being _unlisted_ and becomes _invited_. An org owner mints
per-recipient, email-bound, expiring invites from a link in their approval
email — no login, no dashboard, no ops involvement.

Supersedes the coordinator half of
`docs/superpowers/plans/2026-08-19-registration-invite-deep-links.md`, which
scoped coordinator entry as a permanent, unbound `?org=<parent_org_id>` deep
link. That document's edge-case matrix and its "the org lock is UX-only, the
server must re-validate" rule are retained here; the link mechanism is replaced.

**#619 is not widened.** It ships as-is (§9, D0) and is a prerequisite, not a
dependency. The invite subsystem lands as separate issues.

Related but out of scope: owner registration remains an unlisted deep link
(§8); Signals-DPG#499 (network-admin role) is where owner invites eventually
live; notification-service template ownership is untouched.

---

## 1. Problem

Coordinator and owner registration are public. Every submission emails one
reviewer — the org owner for a coordinator under an org, the `ADMIN_EMAILS`
network-admin list for an owner or a flat coordinator — with approve/reject
links. Business reports the review queue as unmanageable and asks to **control
who can apply**.

The agreed remedy so far (#615 → #619) is to remove registration from app
chrome and serve each form on its own shareable deep link. That removes
accidental discovery. It does not deliver the ask:

| Need                                 | Deep-link-only                                       |
| ------------------------------------ | ---------------------------------------------------- |
| Bound the number of applications     | ✗ a link is a bearer credential with infinite copies |
| Assert the applicant was intended    | ✗ no binding to any identity                         |
| Revoke one bad recipient             | ✗ only revocation is deactivating the whole org      |
| Attribute a leak                     | ✗ every applicant is indistinguishable               |
| Reduce per-application review effort | ✗ unchanged                                          |

An unlisted URL is obscurity applied to a volume problem. In the UP-Ghaziabad
and KA-Dharwad rollouts the dominant sharing channel is WhatsApp forwarding,
where a link travels with implied endorsement and no explanatory context — so
the unlisted link plausibly attracts _higher_-intent traffic than a homepage
button sitting next to copy that explains who should click it.

### 1.1 Two independent causes

The queue is painful for two reasons that need separate fixes:

1. **Volume and eligibility** — anyone with the URL may apply. Fixed here.
2. **Reviewer ergonomics** — one email per submission, no batching, no bulk
   action, no queue view. **Not fixed here.** Tracked separately; it is the
   only mitigation that still works after a link leaks, and it should not be
   folded into this work.

### 1.2 The constraint that shapes the design

There is no ops or implementation-support function; the dev team absorbs that
load. So any design requiring a human to mint invites on request is rejected
regardless of its security properties. Invite issuance must be **self-service
for the org owner** — and the org owner **cannot log in** (§2).

---

## 2. The org owner cannot log in

`apps/api/src/routes/aggregator-org-approvals.ts` — on approval the owner's
Keycloak user is left **disabled** by design:

> The org owner KC user stays DISABLED: org-owner console login is deferred
> (spec §9), and an enabled owner would pass Keycloak's OTP step. Enable them
> only when the org console ships. The role + group are still assigned below so
> that future flip is a no-op.

Three consequences drive everything below:

- **Email is the owner's only interaction surface.** A token-gated emailed page
  is not a stopgap for them; until the org console ships it is the _only_
  possible design.
- **The owner-approved email cannot be modelled on `applicant-approved.ts`.**
  That template's entire payload is a sign-in CTA, which for an owner is a
  promise the platform cannot keep.
- **The grant token needs its own recovery path** (§5.2). An owner who loses
  grant access has no login to fall back on.

Note there are **two** distinct deferred consoles, retired against different
milestones:

| Console               | Deferral              | What moves into it                |
| --------------------- | --------------------- | --------------------------------- |
| Org-owner console     | org-approvals spec §9 | Coordinator invite minting (§5)   |
| Network-admin console | Signals-DPG#499       | Owner registration + invites (§8) |

---

## 3. Precedent: this codebase already does UI-less privileged actions

Nothing here is a new pattern. `apps/api/src/services/approval-token.ts` mints
an HS256 JWT bound to a subject, an `intent` claim, an optional `org` claim and
a TTL; the reviewer clicks it from an email with no session; the API verifies
and renders a server-side HTML confirm page
(`apps/api/src/views/approval-pages.ts`).

An invite is that primitive inverted. Two further pieces are reused verbatim:

- **`POST /admin/v1/orgs/renew/:id`** accepts an **expired-but-signature-valid**
  token as proof the holder once held a legitimate link, and mints a fresh one
  inline. This is the recovery pattern for §6.
- **`renderResultPage`** already accepts
  `action?: { url, token, label }`, rendering a POST-form button with a hidden
  `token` field. This is the recovery _affordance_ for §6.

Also relevant: the shipped `registration_links` subsystem
(`apps/api/src/routes/registration-links.ts`,
`apps/api/src/services/registration-links-store/`) already gives **participant**
registration slug + `draft → live → retired` + `expires_at` + `created_by`, with
a logged-in UI at `/onboarding/links`. Coordinator invites are a different
entity — staff, not participants, and per-recipient rather than per-campaign —
so this is a pattern to follow, not a table to share.

> Note: `apps/api/src/routes/public-registration-links.ts` and `public-lookup.ts`
> both comment that CAPTCHA is enforced "at the BFF layer (Cloudflare
> Turnstile)". No Turnstile implementation exists in `apps/web` or `apps/api`.
> The only real abuse control on the registration path today is a per-`(ip, email)`
> rate limit (`aggregator-registrations.ts:201`). Do not assume a captcha gate
> when reasoning about the unlisted owner link.

---

## 4. The invite primitive

### 4.1 Token

Mirrors `approval-token.ts`: HS256 via `jose`, issuer `aggregator-api`, new
audience `aggregator-invite`, secret reused from `APPROVAL_TOKEN_SECRET`.

| Claim   | Meaning                                      |
| ------- | -------------------------------------------- |
| `sub`   | `jti` of the `registration_invites` row      |
| `role`  | `coordinator` (the only value in this phase) |
| `org`   | `parent_org_id` the invite admits to         |
| `email` | the invited address — **enforced on submit** |
| `exp`   | 14 days, `INVITE_TOKEN_TTL_SECONDS`          |

**Bound to email only.** Phone is the OTP login identity for the portal
(`aggregator-registrations.ts:314`), so binding it would let an owner's
single mistyped digit lock a coordinator out entirely and force a re-mint round
trip through the slowest surface in the system. Phone stays free-entry on the
form. Volume is still bounded by construction: N invites ⇒ at most N
applications.

### 4.2 Store, not a table-free scheme

Approval tokens get single-use for free by re-checking the Keycloak `enabled`
flag before applying a decision. That is unavailable here: **an invitee has no
Keycloak user yet**, so there is nothing to re-check. A row is required, and it
is also what buys revocation and leak attribution.

`registration_invites`:

| Column                      | Notes                                             |
| --------------------------- | ------------------------------------------------- |
| `jti`                       | PK, token `sub`                                   |
| `role`                      | `coordinator`                                     |
| `parent_org_id`             | FK; the invite is scoped to one org               |
| `email`                     | normalised (lowercased, trimmed)                  |
| `status`                    | `pending` \| `consumed` \| `revoked` \| `expired` |
| `expires_at`                |                                                   |
| `created_by`                | the minting owner — audit, non-optional (§7)      |
| `created_at`, `consumed_at` |                                                   |

Unique partial index on `(parent_org_id, email) WHERE status = 'pending'` — one
live invite per address per org, so a re-invite refreshes rather than duplicates.

Follows the existing base-class store pattern
(`registration-links-store/{interface,postgres}.ts`) per `.claude/rules/`:
abstract base + `StoreResult<T>` + `NOT_FOUND` / `DB_UNAVAILABLE` error codes,
aggregator-scoping enforced at the store boundary.

### 4.3 Mint stays behind an endpoint, not inside the page handler

This is the one rule that makes the eventual console migration cheap.

```
services/invite-token.ts                 mint / verify   (mirrors approval-token.ts)
services/registration-invites-store/     interface.ts + postgres.ts
POST /admin/v1/invites                   the mint endpoint
   ├── caller 1: emailed owner page      §5, now
   └── caller 2: org-owner / network-admin console   later
```

Moving invite minting into a console becomes _wiring a second caller_. Putting
the mint logic in the page handler would make it a rewrite.

### 4.4 Enforcement on submit

In `aggregator-registrations.ts`, for a submission carrying an invite:

1. Verify signature, audience, `exp`.
2. Load the row by `jti`; require `status = 'pending'`.
3. **Submitted email must equal the `email` claim** (normalised compare).
4. Re-validate the submitted `org_id`: exists, `active`, belongs to this
   network — _independently of the token_, never trusting a hidden field.
   (Retained from the superseded doc's §5; still correct, now backed by a
   bound identity rather than a UX-only lock.)
5. Stamp `parent_org_id` from the claim so the approval path's
   `parent_org_id` ↔ token binding can never hit a mismatch.
6. **CAS the invite `pending → consumed` _before_ creating anything**, and
   proceed only if the compare-and-swap returns a row. A single transaction
   spanning the registration insert is not available — the path also provisions
   a Keycloak user — so atomicity comes from claiming the invite first, the same
   shape as `orgStore.approve`'s CAS in `aggregator-org-approvals.ts`. A
   concurrent double-submit loses the CAS and renders already-registered
   instead of double-creating. If downstream provisioning then soft-fails, the
   invite stays `consumed` and recovery is the §6 owner re-mint path — chosen
   deliberately over releasing the invite, which would reopen the
   double-create window.

---

## 5. The owner's invite page

### 5.1 Flow

```
Owner-approved email ──CTA──▶ /register/invite?grant=<owner-grant-jwt>
                                  │  textarea: one "email" or "email, name" per line
                                  └──POST──▶ /admin/v1/invites   (mint N × 14d)
                                              └──▶ coordinator-invite email each
                                                     └──▶ /register/coordinator?invite=<jwt>
```

Because binding is email-only (§4.1) the page collects **only** email
addresses — no phone field at mint time. The optional `name` after the comma is
used solely to greet the recipient in the invite email; it is neither stored on
the invite row nor enforced against what the coordinator later submits.

**Bulk by default.** A textarea of one address per line, minting N invites in
one submission. An owner onboarding a district's worth of coordinators one at a
time through an emailed page is a realistic abandonment risk, and every extra
round trip runs through email, the slowest surface available to them.

Result page reports `X sent · Y already invited (resent) · Z invalid`. Partial
failure is normal and must not roll back the successful mints.

### 5.2 Grant token — 90 days, renewable

The grant (the owner's access to the mint page) and the invites it mints have
**different lifetimes**. Invites are 14 days. A 14-day grant would strand the
owner permanently, because they cannot log in (§2).

- `GRANT_TOKEN_TTL_SECONDS`, default **90 days**, audience `aggregator-grant`,
  `sub` = `parent_org_id`.
- Expired-but-signature-valid grant → result page with a **"Email me a fresh
  invite link"** action, mirroring `orgs/renew/:id` exactly.
- The refreshed grant is emailed to the org's **registered owner email on
  file** — never to an address supplied in the request. The recovery path is
  therefore not a redirection primitive for an attacker holding a stale grant.
- Revoked implicitly when the org leaves `active`, matching the revocation model
  already chosen for org-scoped links.

### 5.3 New email templates

Both are **new** templates, not edits to ones product has already signed off —
which should simplify the signoff ask.

| Template                | Trigger               | Payload                                          |
| ----------------------- | --------------------- | ------------------------------------------------ |
| `org-owner-approved.ts` | org approve (§2 hook) | org is live; **no sign-in CTA**; grant link      |
| `coordinator-invite.ts` | mint                  | who invited them, which org, invite link, expiry |

Email templates are **TypeScript compiled into the image**
(`apps/api/src/services/email-templates/*.ts`) — there is no JSON template
layer anywhere in the repo. Terms, privacy and consent _are_ config
(`config/<network>/[brand]/schemas/*/consent.json` via `loadConsentConfig`), but
templates are not. So this work does **not** wait on the config→DB migration.
Conversely, "network-admin edits email templates without a support ticket"
needs a template-externalisation step that does not exist yet and is not
covered by the consent-config move — scope it into Signals-DPG#499 explicitly
rather than assuming it comes for free.

---

## 6. Failure handling and recovery

The superseded doc routed **every** failure to `/login`. That is right for most
cases and wrong for the most common one: it discards the single situation where
the platform can safely help, and — with "Become a member" removed from
`/login` per #619 — turns a legitimate coordinator into a support ticket.

The table below governs the **coordinator invite** (`?invite=`). Grant-token
(`?grant=`) failures follow §5.2: expired-but-signature-valid offers the
email-me-a-fresh-link action, and every other grant failure falls through to
`/login` on the same no-information-leak rule.

| Condition                                                                                      | Response                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Expired, signature valid                                                                       | Result page + **"Request a fresh invite"** → POSTs the dead token → notifies the org owner → owner re-mints |
| Already consumed                                                                               | Result page → "already registered, sign in"                                                                 |
| Invalid signature / malformed / revoked / org not `active` / off-network / flag off / no token | `/login` — one fallback, no information leak                                                                |
| Already-authenticated visitor                                                                  | `/dashboard`, mirroring today's `/register`                                                                 |

Independently of the above, `/login` gains a support line ("Need access?
Contact your organisation administrator / `SUPPORT_EMAIL`"). It costs nothing
and preserves the invite-only property.

**Owner typo is a new failure mode.** Under an unbound link, a mistyped address
is harmless; under an email-bound invite it renders the invite undeliverable
_and_ blocks the coordinator entirely. The owner-notify path above is what
covers it — the coordinator has no self-service route, by design.

---

## 7. Security posture

### 7.1 What improves

- Volume bounded by construction — N invites ⇒ ≤ N applications.
- Per-invite revocation, and native expiry instead of "revoke by deactivating
  the whole org".
- `jti` + `created_by` give **leak attribution**: whether an owner broadcast a
  link or one coordinator forwarded it is now answerable. This is an audit
  argument for tokens independent of volume control.
- No internal UUIDs in shared URLs. The superseded design put a raw
  `parent_org_id` into WhatsApp-forwarded links.

### 7.2 What gets worse, and the mandatory mitigations

**A1 moves the leak surface from "registration link" to "owner grant link."** A
leaked grant lets the holder send **platform-branded email to arbitrary
addresses** — a phishing and spam-amplification vector, worse _in kind_ than
the current leak, which only yields junk applications.

These are not optional hardening; without them this design is a net downgrade:

1. **Per-org invite rate limit** — window + max, following the
   `PUBLIC_SUBMIT_RATE_*` config shape. Caps blast radius of a leaked grant.
2. **`created_by` + `jti` on every row** — full audit of who minted what for
   whom.
3. **Grant revoked when the org leaves `active`.**
4. **Recovery delivers only to the registered owner email on file** (§5.2), so
   recovery is not itself a mail-redirection primitive.

### 7.3 Unchanged

Server-side `org_id` re-validation, downstream reviewer approval, and the
`parent_org_id` ↔ decision-token binding all remain. The invite is an
additional gate at the front, not a replacement for any of them.

---

## 8. Owner registration stays interim

Owner registration remains the unlisted `/register/owner` deep link shipped in
`1e5573b` — unbound, no invite, gated on `ORG_HIERARCHY_ENABLED`.

Rationale: minting owner invites has no self-service issuer. The network admin
cannot log in either, and out-of-band minting was rejected on the §1.2
constraint. The accepted risk is therefore explicit: **owner registration has
no volume control**, mitigated only by the existing per-`(ip, email)` rate limit
and reviewer approval.

This must be recorded as an accepted risk on #619 rather than left implicit,
and owner-invite generation must be added to Signals-DPG#499's capability list
so the interim has a named landing place instead of being orphaned.

> Note: #499 states it is blocked on the realm-topology fork in Signals-DPG#420
> (one shared `bluedots` realm vs per-DPG realms). That decision has since
> settled on one shared per-network realm, so #499 may be unblockable — relevant
> to sprint planning, and to when this interim can be retired.

---

## 9. Sequencing

|        | Deliverable                                                                                | Depends on | Size                     |
| ------ | ------------------------------------------------------------------------------------------ | ---------- | ------------------------ |
| **D0** | #619 as-is + `/login` support line (§6)                                                    | —          | ~½ day (largely shipped) |
| **D1** | `org-owner-approved` template + hook in the org approve path                               | —          | ~1 day                   |
| **D2** | Invite primitive: token, store, migration, submit enforcement (§4)                         | —          | ~2–3 days                |
| **D3** | Owner invite page, bulk mint, `coordinator-invite` template, rate limit, recovery (§5, §6) | D1, D2     | ~2–3 days                |

Roughly 1–1.5 dev-weeks, plus product signoff on the two new templates in §5.3.

D1 and D2 are independent and can run in parallel. **D1 is the hard blocker on
the flow as a whole** — until the owner-approved email exists, no grant link
reaches any owner and the coordinator path is inert regardless of what else
ships.

---

## 10. Testing

- **Token** — mint/verify round trip; tampered signature; expired; wrong
  audience (`aggregator-invite` vs `aggregator-grant` vs `aggregator-admin`);
  missing claims.
- **Store** — `pending → consumed`; revoke; the partial unique index rejecting
  a second live invite for the same `(org, email)`; `DB_UNAVAILABLE` mapping.
- **Submit** — mismatched email → 4xx; consumed invite → already-registered;
  inactive/off-network `org_id` rejected _even when the token's claim is valid_;
  `parent_org_id` always stamped.
- **Recovery** — expired-signature-valid → result page carrying the action
  button; invalid signature → `/login`; recovery email addressed to the
  registered owner email even when the request supplies a different one.
- **Bulk mint** — dedupe; partial-failure summary; per-org rate limit trips.
- **Templates** — extend the existing snapshot suite
  (`services/email-templates/templates.test.ts`) for both new templates.
- **#619 fallout** — `LoginView.test.tsx` (the "Become a member" click test) and
  `register-page.test.tsx` (bare `/register` → `/login`).

---

## 11. Open

- Whether an org owner may consume a coordinator invite minted for their own
  email (role overlap). Now _decidable_ rather than open-ended — the invite
  binds one address — but the product answer is still needed.
- Reviewer-side batching (§1.1 cause 2) needs its own issue. It is deliberately
  excluded here.
