# Registration is invite-only via shareable deep links

**Ticket:** aggregator-dpg#619 · **Parent:** #615 · **Status:** Design · **Date:** 2026-08-19

> Reconstructed design doc (the original untracked draft was lost). Sourced from
> the #619 body and the 2026-08-19 coordinator design decision
> (issue comment 5342286086).

## 1. Purpose

Registration stops being discoverable from the app. Both the **coordinator** and
**owner** signup forms are served only on their own shareable deep links (direct
URL / QR), and the "Become a member" entry point is removed from the login page.
The product is **invite-only**: you register because someone shared you a link,
never by finding a button in the UI.

- Coordinator → `/register/coordinator?org=<parent_org_id>`
- Owner (organisation) → `/register/owner`
- Bare `/register` no longer surfaces either form → redirect to `/login`.

## 2. Scope

1. **Both flows → deep links only.** Neither form is reachable from app chrome.
   The bare public `/register` redirects to `/login`.
2. **Remove "Become a member" from login.** `/login` shows only Sign in.
   Pointer: `apps/web/src/app/(public)/login/LoginView.tsx` (`Welcome` panel /
   `onRegister` → `goRegister`), i18n `register_title` / `register_sub`
   (`messages/{en,kn,hi}.json`), and `LoginView.test.tsx` (the register-click test).
3. **Owner CTA copy:** `register.org_submit` "Submit organisation" →
   "Register as aggregator owner" (en/kn/hi; kn/hi native review).

## 3. Coordinator deep-link design (decided 2026-08-19)

**Route:** `/register/coordinator?org=<parent_org_id>`

- The org owner receives this link in their **approved** email and shares it only
  with their coordinators.
- The form **prefills + locks** the org from the `org` param. The public
  `/api/orgs` dropdown (and the anonymous org list it exposed) is **removed** from
  the public flow — no enumeration.
- Display the org **name** (single lookup by id, no enumeration) so the
  coordinator sees which org they're joining. Lookup failure → `/login`.
- **Any query problem → `/login`** — one safe fallback for every failure mode.

**Dependency:** requires the **org-owner approved email** to exist. Today the org
approval path enables the owner + assigns `org_owner` but sends **no email**
(unlike the coordinator flow). That email is what carries this link — it must be
added.

## 4. Edge cases → all resolve to `/login`

**Org resolution / state**

- Org id pending / rejected / inactive / retired (not just "not found") → `/login`.
  Only an **active** org accepts coordinators.
- Org deactivated after the link was shared → link stops (active-check is the
  revocation path; the link itself is permanent / no expiry).
- Cross-network / cross-brand org id (not this deployment's network) → `/login`.
- Malformed / truncated `org` param → `/login`.

**Flag**

- `ORG_HIERARCHY_ENABLED` off (globally, or toggled off after link creation) → `/login`.
- Bare `/register/coordinator` with no `org` (flag on, selector removed) → `/login`.

**Auth / session**

- Already-authenticated visitor → `/dashboard` (mirrors today's `/register`), not the form.
- The `/login` redirect target no longer has the "Become a member" CTA (this
  ticket), so a mis-linked visitor has no register path. Intended (invite-only) —
  accepted.

**Duplicate / re-entry**

- Coordinator already registered (same email/phone): pending → resubmit-reclaim;
  active → block/redirect. Re-opening the link must not double-create.
- Org-switch (same person opens org A then org B link): decide which
  `parent_org_id` wins (last submission vs block-if-bound). **[OPEN]**
- Owner opening their own coordinator link (role overlap): decide if allowed. **[OPEN]**

## 5. Security / trust boundary

- **The org lock is UX-only.** The submit still sends `org_id`; the server MUST
  re-validate the submitted `org_id` (active + belongs to this network) and never
  trust the locked/hidden field. Real gates stay: server validation + downstream
  admin approval + the `parent_org_id` ↔ token binding on the decision path.
- **No per-invite expiry.** The raw `parent_org_id` link has no expiry;
  revocation is only via deactivating the org. (A signed-token variant is the
  alternative if per-invite revocation is ever needed — raw id chosen
  deliberately.)
- **Consistency:** registration must always stamp `parent_org_id` when the `org`
  param is present, so approval (which enforces the `parent_org_id` binding
  regardless of the runtime flag) never hits a mismatch.

## 6. Already done — commit `1e5573b` (this branch)

- Owner registration moved to `/register/owner` deep link (`owner/page.tsx` +
  `OwnerRegisterView.tsx`), gated on `ORG_HIERARCHY_ENABLED` + org schema
  (`notFound()` otherwise); shared `RegisterShell`.
- Owner CTA copy done; dead tab keys (`tab_coordinator` / `tab_org` /
  `page_title`) removed.

## 7. Remaining

- Coordinator → `/register/coordinator?org=<parent_org_id>` deep link with
  prefill+lock + org-name display; strip the coordinator form from the public
  `/register` (make `RegisterView` deep-link-served).
- Remove the public `/api/orgs` dropdown from the coordinator flow.
- Redirect bare `/register` → `/login`.
- Remove "Become a member" from login (§2.2) + fix `LoginView.test.tsx`.
- Add the **org-owner approved email** carrying the coordinator link (§3 dependency).
- Server-side re-validation of the submitted `org_id` (§5).
- Resolve the two **[OPEN]** decisions (org-switch precedence; owner-uses-own-link).

## 8. Acceptance

- Bare `/register` → `/login`; neither form discoverable from app chrome.
- Login shows only Sign in (no "Become a member").
- Coordinator link prefills+locks the org, shows its name, and every failure mode
  lands on `/login`.
- Server rejects a submitted `org_id` that is inactive or off-network regardless
  of the locked field.
- Owner flow unchanged (`ORG_HIERARCHY_ENABLED`).
