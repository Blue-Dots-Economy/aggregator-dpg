# Invite-only onboarding for orgs and coordinators

## Summary

Orgs and coordinators join only by invite. An invite sent by an org owner or admin needs no approval. The invitee submits the form, then verifies with an email OTP in place of approval, and lands in the portal signed in.

## Highlights

| Item              | Change                                                                            |
| ----------------- | --------------------------------------------------------------------------------- |
| Self-registration | Removed for orgs (`/register/owner`) and coordinators (`/register`)               |
| Approval hop      | Removed; the invitee is OTP-verified instead of approved                          |
| APIs              | Separate invites: `/v1/org/invite` (org + owner), `/v1/user/invite` (coordinator) |
| Email             | Locked to the invited address                                                     |
| Sign-in           | Form submit → Keycloak OTP, email channel by default → portal                     |

## 1. Scope

| In scope                                                                                   | Out of scope                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Invite an org (child of an org the inviter holds `orgs.onboard` in)                        | Bulk participant onboarding                 |
| Invite a coordinator (into an org the inviter holds `org.manage` in)                       | Changes to roles and capabilities           |
| Activation on the first email OTP                                                          | Org tree limits (unchanged, still enforced) |
| Email OTP sign-in straight after accept; the OTP verifies the invitee in place of approval | Participant registration links              |
| Retiring the approval endpoints, emails and console actions                                | -                                           |

## 2. Flows

### Today

```mermaid
flowchart LR
  A[Public form<br/>or invite link] --> B[Account created<br/>status pending]
  B --> C[Review email<br/>to org owner]
  C --> D{Owner decides}
  D -->|approve| E[Active, can sign in]
  D -->|reject| F[Inactive]
```

Org owners also get a grant link (`/register/invite?grant=`) after approval, which they use to invite coordinators without signing in.

### New

```mermaid
sequenceDiagram
  actor I as Inviter
  participant W as Web
  participant A as API
  participant K as Keycloak
  actor N as Invitee
  I->>W: 1. Invite org or coordinator
  W->>A: POST /v1/{org|user}/invite
  A->>N: 2. Invite email
  N->>W: 3. Open link, fill form
  W->>A: POST …/invite/accept
  Note over A: 4. Create account, unverified
  A->>W: 201 + login hint
  W->>K: 5. Authorize, login_hint=email
  K->>N: 6. OTP by email only
  N->>K: Enter OTP
  K->>W: 7. Tokens
  W->>A: 8. POST /v1/user/activate
  Note over A: Activate account
  A->>W: 9. Active → portal
```

| Step | What happens                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------ |
| 1    | Inviter invites an org (child of their org) or a coordinator (into their org) from the console   |
| 2    | One invite per recipient (existing mint logic, 14-day TTL from `INVITE_TOKEN_TTL_SECONDS`)       |
| 3    | The accept page for that invite type renders its form; the email is read-only                    |
| 4    | Creates the account as `pending`; Keycloak user enabled with `decision_made = invited`, no roles |
| 5    | Web forwards `login_hint` so the identifier step is skipped                                      |
| 6    | An `invited` user gets the email channel only, so a passed OTP proves the invited email          |
| 7    | The portal gate admits `invited` users this far                                                  |
| 8    | The auth callback sees an unverified account and calls `activate` with the new token             |
| 9    | API runs the existing approve step; the session is refreshed so the new roles apply              |

```mermaid
stateDiagram-v2
  [*] --> pending: invite accepted
  pending --> active: first email OTP
  pending --> [*]: unverified, pruned
```

`pending` now means "accepted, email not yet verified". Later sign-ins are normal and may use either channel.

## 3. Invite APIs

Org and coordinator invites are separate APIs. An org invite creates an org and onboards its owner. A coordinator invite creates one user. Both follow the same steps; the owner and the coordinator differ only in user type.

| Endpoint                          | Auth                          | Purpose                                                                                              |
| --------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /v1/org/invite`             | `orgs.onboard` in `parent_id` | Mint and email org invites. Body `{ parent_id, recipients[] }`                                       |
| `GET /v1/org/invite/read?token=`  | Invite token                  | Parent org name, locked email, expiry                                                                |
| `POST /v1/org/invite/accept`      | Invite token                  | Create the org, its Keycloak group and the owner user, all `pending`; return `login_hint`            |
| `POST /v1/user/invite`            | `org.manage` in `org_id`      | Mint and email coordinator invites. Body `{ org_id, recipients[] }`. Replaces `POST /v1/user/create` |
| `GET /v1/user/invite/read?token=` | Invite token                  | Org name, locked email, expiry                                                                       |
| `POST /v1/user/invite/accept`     | Invite token                  | Create the coordinator user, `pending`; return `login_hint`                                          |
| `POST /v1/user/activate`          | User token (after email OTP)  | Activate the caller's own `pending` account; for an owner, also its org. No-op when already active   |

|                  | Org invite                                                                     | Coordinator invite                                                                        |
| ---------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Invite row       | `registration_invites`, `role = org_owner`, `org_id` = parent                  | `registration_invites`, `role = coordinator`, `org_id` = target org                       |
| `accept` creates | Org + Keycloak group + owner user (existing `POST /v1/orgs/create` logic)      | Coordinator user (existing `POST /v1/aggregator-registrations/create` logic)              |
| `activate` runs  | `decideOrg(approve)`: `grantOwnerAccess` (`org_owner`, group), CAS to `active` | `decideCoordinator(approve)`: Signals upsert, `decision_made = approved`, CAS to `active` |
| Limits           | Org tree limits checked at invite and again at accept                          | -                                                                                         |

Token minting, consume and release stay shared services (`services/invites/`) under both APIs. The decider is recorded as `invite:<inviter id>`. A failed `activate` leaves the account `pending`; the next sign-in retries it.

### Retired

| Endpoint                                                                                                   | When                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `POST /v1/orgs/create`, `POST /v1/aggregator-registrations/create`                                         | At cut-over                                 |
| `POST /v1/user/create`                                                                                     | At cut-over (moved to `/v1/user/invite`)    |
| `POST /admin/v1/invites` (owner grant)                                                                     | At cut-over; owners invite from the console |
| `/admin/v1/orgs/{read,decision,renew}/:id`, `/admin/v1/aggregator-registrations/{read,decision,renew}/:id` | After the pending backlog is drained        |
| `POST /v1/user/decision/:id`, `POST /v1/org/decision/:id`                                                  | After the pending backlog is drained        |

## 4. Changes by layer

### Database

| Item                                   | Change                                                   |
| -------------------------------------- | -------------------------------------------------------- |
| `registration_invites.role`            | Accept `org_owner` alongside `coordinator`               |
| `registration_invites_pending_unique`  | `(org_id, email)` → `(org_id, role, email)`              |
| `users.status`, `organisations.status` | No enum change; `pending` means awaiting first email OTP |
| Data migration                         | None                                                     |

### API

| Item                                | Change                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Invite routes                       | Org invite routes in `v1-org.ts`, user invite and activate routes in `v1-user.ts`; grant route `routes/invites.ts` removed |
| Email lock                          | Reject when the submitted email differs from the invite (`INVITE_EMAIL_MISMATCH`)                                          |
| Review emails                       | Removed (`sendAdminReviewEmail`, `sendOrgReviewEmail`)                                                                     |
| Stale prune                         | `cleanup-stale` also deletes `pending` invited accounts not verified within the invite TTL                                 |
| Approved emails and grant mail      | Removed; the invitee signs in directly                                                                                     |
| RBAC route table and `openapi.json` | Regenerated                                                                                                                |

### Web

| Item                                     | Change                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/register`                              | Removed; show "Onboarding is by invite only"                                                               |
| `/register/owner`                        | Opens only with `?invite=`; calls `/v1/org/invite/accept`                                                  |
| `/register/coordinator?invite=`          | Calls `/v1/user/invite/accept`                                                                             |
| `/register/invite?grant=`                | Removed                                                                                                    |
| Console invites                          | Existing coordinator invite page uses `/v1/user/invite`; new "Invite organisation" action on the orgs page |
| Console pending lists and decide buttons | Removed after the backlog is drained                                                                       |
| `/api/auth/login`                        | Forward `login_hint` to the authorize URL                                                                  |
| Accept submit                            | Redirect to `/api/auth/login?login_hint=<email>`                                                           |
| `/api/auth/callback`                     | Call `/v1/user/activate` for an unverified account, then refresh the token                                 |

### Keycloak

> [!IMPORTANT]
> The OTP login changes are made in the [`sanketika-labs/keycloak-otp-authenticator`](https://github.com/sanketika-labs/keycloak-otp-authenticator) repo, not here. Two features are needed: use the pre-filled email (`login_hint`), and send the code to email only for `invited` users. Check what the authenticator supports today before the Keycloak phase starts.

| Item                      | Change                                                                                                  | Where                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `otp-identifier-form`     | Use `login_hint` and skip the identifier step                                                           | `keycloak-otp-authenticator`                                |
| `otp-channel-choice-form` | New `otpChoice.defaultChannel=email`; skip the choice screen. Email only when `decision_made = invited` | `keycloak-otp-authenticator` + realm config                 |
| Portal gate               | Admit `decision_made = invited` as well as `approved`                                                   | `apply-portal-gate.py` + its verifier test                  |
| `decision_made`           | New value `invited`; stays admin-only                                                                   | `apply-user-profile.sh` (no change if values are free text) |
| Deployment realm          | Same config                                                                                             | bluedots-automation                                         |

## 5. Rollout

```mermaid
flowchart LR
  P1[1. API<br/>accept + activate] --> P2[2. Web<br/>accept page, console]
  P2 --> P3[3. Keycloak<br/>login_hint, email default]
  P3 --> P4[4. Cut-over<br/>block self-registration]
  P4 --> P5[5. Cleanup<br/>remove approval paths]
```

| Phase        | Note                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| 1–3          | Old paths keep working; ships as the API / Web / Infra PR stack                     |
| 4            | Self-registration endpoints return `404`; public forms removed                      |
| 5            | Pending rows are decided with the existing endpoints first, then those endpoints go |
| Open invites | Pending coordinator invites stay valid and are accepted on the new page             |

## 6. Risks and open questions

| Item                      | Detail                                                       | Proposal                             |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| Notify the inviter        | Review email goes away; the inviter learns nothing on accept | Send a short "X has joined" email    |
| Grant links in old emails | Stop working at cut-over                                     | Show a sign-in prompt on the old URL |
| Default org               | Takes no invites, so no new members join it                  | Confirm this is intended             |
