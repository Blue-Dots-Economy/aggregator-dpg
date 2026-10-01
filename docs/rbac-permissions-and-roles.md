# RBAC Catalogue — Permissions & Default Roles

## Summary

The fixed permission catalogue and default roles for signals-dpg and aggregator-dpg, and the rules for building custom roles.

## Highlights

| Item            | Value                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Naming          | `<resource>:<action>`, e.g. `participant:decrypt`. One permission is checked by both APIs wherever the operation crosses them.                      |
| Size            | 24 permissions: 21 for people, 3 service-only                                                                                                       |
| Implicit access | Every signed-in user can read their own account and contact support. Any role on a unit or org lets the holder read that node's profile and config. |
| System roles    | 11 human roles and 5 service roles. They cannot be edited; you can clone them.                                                                      |
| Custom roles    | Built only from catalogue permissions, owned by platform or an org, capped by the org's entitlement and the granter's own ceiling                   |

---

## 1. Permission catalogue

Every permission is a code constant. Deploys seed them into the registry. There is no API to add, rename or delete one (§2.4).

| Flag  | Meaning                                       | Effect                                                                                         |
| ----- | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `S`   | Sensitive: exposes or processes decrypted PII | Every use writes an audit row. Network Admin can withdraw it from an org's entitlement (§2.3). |
| `D`   | Destructive or irreversible                   | Confirm dialog in the UI; audit row                                                            |
| `SVC` | Service principals only                       | Never shown in the role builder                                                                |

Scopes: `P` platform (the instance), `O` org, `U` unit (an aggregator), `Me` the caller's own resources. A grant applies at its scope and every scope below it.

### 1.1 Self-service (Participant)

| Permission     | Covers                                                                                                                                                | Scopes | Flags | Enforced at                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----- | -------------------------------------------------------------------------------- |
| `self:account` | Declare domain; terms, privacy and profile consent; U18 DOB and guardian OTP flows                                                                    | Me     | -     | `/user/domains`, `/consent/*` (authenticated routes)                             |
| `self:items`   | Create, read, update, pause, unpause, retire and delete own items                                                                                     | Me     | -     | `/item/create`, `/item/fetch`, `PATCH`/`DELETE /item/:itemId`, `/item/lifecycle` |
| `self:actions` | Match score; perform (single and bulk); read, accept, reject, complete and cancel actions; events; reveal the counterparty's contact after acceptance | Me     | -     | `/match-score/calculate`, `/action/*`, `/event/*`                                |

Revealing a contact is audited whatever the permission says (`pii_reveal_audit`).

### 1.2 Participants and campaigns (operators)

| Permission            | Covers                                                                                                                                                                                                                    | Scopes  | Flags | Enforced at                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `participant:read`    | Dashboards and rollups, onboarding metrics, participant lookup, masked item lists, registration links, bulk-upload status, campaign job status                                                                            | U, O, P | -     | signals `GET /admin/participant`, `/aggregator/dashboard`; aggregator `GET /v1/dashboard`, `/v1/onboarding/*`, `GET /v1/links*`, `GET /v1/bulk-uploads*`, `GET /v1/campaign/*`                                 |
| `participant:manage`  | Onboard and update participants and their items. Pause and unpause items. Act on a participant's behalf. Create, edit, activate and retire registration links. Run bulk uploads, including the template and `errors.csv`. | U, P    | -     | signals `POST /admin/participant`, `/item/create` (`created_by`), `PATCH /item/:itemId`, `/item/lifecycle` (pause), `/action/perform*` (on behalf); aggregator `/v1/links*` writes, `/v1/bulk-uploads*` writes |
| `participant:retire`  | Retire a participant's item: PII scrub, cancel connections, de-index                                                                                                                                                      | U, P    | `D`   | signals `/item/lifecycle` (`retire`) on an item the caller does not own                                                                                                                                        |
| `participant:export`  | Masked CSV exports                                                                                                                                                                                                        | U, O    | -     | signals `/aggregator/dashboard/export`; aggregator `GET /v1/dashboard/export`, "Export selected CSV"                                                                                                           |
| `participant:decrypt` | Any decrypted-profile read: dashboard profile export, campaign export job                                                                                                                                                 | U, P    | `S`   | signals `POST /admin/participant/decrypt`; aggregator `POST /v1/dashboard/export/profiles`, `POST /v1/campaign/export`                                                                                         |
| `campaign:run`        | Start email and voice campaigns and dashboard bulk actions                                                                                                                                                                | U, O    | `S`   | aggregator `POST /v1/campaign/email`, `POST /v1/campaign/voice`, `POST /api/dashboard/actions`                                                                                                                 |

`campaign:run` is `S` because the worker decrypts contacts to send. No person sees the decrypted fields.

### 1.3 Orgs and units

| Permission       | Covers                                                                    | Scopes | Flags | Enforced at                                                               |
| ---------------- | ------------------------------------------------------------------------- | ------ | ----- | ------------------------------------------------------------------------- |
| `org:read`       | List orgs and their units and domains                                     | O, P   | -     | aggregator `GET /v1/orgs`; signals org list (no route yet)                |
| `org:manage`     | Edit org details; transfer ownership (current Org Owner only)             | O      | `D`   | No route yet                                                              |
| `org:govern`     | Approve, reject and offboard orgs                                         | P      | `D`   | aggregator `/admin/v1/orgs/*`                                             |
| `unit:configure` | Edit the unit profile and contact                                         | U      | -     | aggregator `PATCH /v1/aggregators/profile/me`                             |
| `unit:govern`    | Approve, reject and offboard units (aggregator/coordinator registrations) | O, P   | `D`   | aggregator `/admin/v1/aggregator-registrations/{read,decision,renew}/:id` |

### 1.4 Access management

| Permission          | Covers                                                                                     | Scopes  | Flags | Enforced at                                                        |
| ------------------- | ------------------------------------------------------------------------------------------ | ------- | ----- | ------------------------------------------------------------------ |
| `access:read`       | View members, their roles, roles and the catalogue                                         | U, O, P | -     | `GET /iam/roles`, `GET /iam/bindings`, `GET /iam/catalogue`        |
| `access:manage`     | Invite and remove members; assign and revoke roles within the grant ceiling                | U, O, P | -     | `POST`/`DELETE /iam/bindings`; aggregator `POST /admin/v1/invites` |
| `role:manage`       | Create, edit, clone and delete custom roles at the owner scope                             | O, P    | -     | `/iam/roles` writes                                                |
| `access:administer` | Set org entitlements; register service clients, assign service roles and rotate their keys | P       | `D`   | `/iam/orgs/:orgId/entitlement`, service-client admin               |
| `audit:read`        | Read IAM and PII audit logs for the scope                                                  | O, P    | `S`   | `GET /iam/audit`                                                   |

### 1.5 Platform

| Permission          | Covers                                                                                                             | Scopes | Flags | Enforced at                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ | ----- | ------------------------------------------------------------------------- |
| `network:configure` | Refresh the schema cache; publish `network.json`, item schemas and consent documents; nominate default aggregators | P      | `D`   | signals `POST /network/refetch_schemas`; the rest are files and SQL today |
| `user:administer`   | Ban or unban a user; clear a single-domain lock                                                                    | P      | `D`   | No route yet (`user.banned` column and support SQL)                       |

### 1.6 Service-only

| Permission         | Covers                                                                 | Scopes | Flags     | Enforced at                                                                                                 |
| ------------------ | ---------------------------------------------------------------------- | ------ | --------- | ----------------------------------------------------------------------------------------------------------- |
| `org:sync`         | Mirror orgs and units into Signals; delete stale pending registrations | P      | `SVC` `D` | signals `POST /admin/aggregator/upsert`; aggregator `POST /admin/v1/aggregator-registrations/cleanup-stale` |
| `network:federate` | Peer-instance reads and cross-instance action writes                   | P      | `SVC`     | signals `/network/item/*_local`, `POST /network/action/perform`                                             |
| `network:dump`     | Presigned URLs for the network-wide non-PII dump                       | P      | `SVC`     | aggregator `GET /v1/campaign/dump`                                                                          |

### 1.7 No permission needed

| Access                                         | Operations                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public (rate limits, Turnstile, signed tokens) | Signals: `/`, `/health/*`, `/auth/config`, `/auth/session*`, `/auth/signup`, `/auth/u18-precheck`, `/network/schemas`, `/network/schema/*`, `/network/item/fetch`, `/network/item/markers`, `/network/item/discover`, `/consent/status-by-identifier`, `/consent/u18/signup/guardian*`. Aggregator: `/health/*`, `/v1/aggregator-config`, `/v1/participant-consent`, `/public/v1/aggregators/:orgSlug/*`. |
| BFF service token only (`svc:aggregator_bff`)  | `POST /v1/aggregator-registrations/create`, `POST /v1/orgs/create`                                                                                                                                                                                                                                                                                                                                        |
| Any signed-in user                             | Signals `GET /auth/me`, `/support/*`; aggregator `/v1/support/*`                                                                                                                                                                                                                                                                                                                                          |
| Any role on the unit or org                    | aggregator `GET /v1/aggregators/profile/me`, `GET /iam/me`                                                                                                                                                                                                                                                                                                                                                |

---

## 2. Roles

### 2.1 System roles

System roles are seeded from code. They cannot be edited or deleted, but they can be cloned into a custom role.

| Key                   | Name                | Bound at | Purpose                                                                          | Assigned by                                                          |
| --------------------- | ------------------- | -------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `network_admin`       | Network Admin       | P        | Governance, network config, entitlements, access, moderation. No PII.            | Bootstrap script (`create_admin_user.ts`), then other Network Admins |
| `network_auditor`     | Network Auditor     | P        | Read-only oversight, audit logs                                                  | Network Admin                                                        |
| `support_agent`       | Support Agent       | P        | Find participants, ban users, clear domain locks. No decrypt.                    | Network Admin                                                        |
| `org_owner`           | Org Owner           | O        | Runs one org: members, custom roles, unit approvals, org-wide read. One per org. | Automatic on org approval                                            |
| `org_admin`           | Org Admin           | O        | Org Owner without custom-role authoring, audit access or ownership transfer      | Org Owner                                                            |
| `org_viewer`          | Org Viewer          | O        | Read-only, whole org, masked                                                     | Org Owner, Org Admin                                                 |
| `coordinator`         | Coordinator         | U        | Unit lead: onboarding, campaigns, gated PII, unit members                        | Automatic on unit approval; Org Owner/Admin                          |
| `onboarding_operator` | Onboarding Operator | U        | Links, bulk uploads, participant onboarding. No export, no PII.                  | Coordinator, Org Owner/Admin                                         |
| `campaign_operator`   | Campaign Operator   | U        | Email and voice campaigns; masked export                                         | Coordinator, Org Owner/Admin                                         |
| `unit_viewer`         | Unit Viewer         | U        | Read-only, one unit, masked                                                      | Coordinator, Org Owner/Admin                                         |
| `participant`         | Participant         | Me       | Seeker or provider using the Signals portal                                      | Implicit for every provisioned user                                  |

Service roles belong to Keycloak service clients and API keys. They never appear in the role builder.

| Key                    | Client today       | Permissions                                                                                       | Condition                                                         |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `svc:aggregator_api`   | `aggregator-dpg`   | `participant:read`, `participant:manage`, `participant:export`, `participant:decrypt`, `org:sync` | User-data calls carry the acting user; effective = service ∩ user |
| `svc:aggregator_bff`   | `aggregator-bff`   | `org:read`                                                                                        | No user data                                                      |
| `svc:voice_bot`        | `voice-dpg` / Raya | `self:items`, `self:actions`                                                                      | Only for the OTP-verified caller (IAM spec D7)                    |
| `svc:campaign_manager` | `campaign-manager` | `participant:read`, `participant:decrypt`, `campaign:run`, `network:dump`                         | Intersects with the operator's token, except `network:dump`       |
| `svc:peer_instance`    | Peer instances     | `network:federate`                                                                                | -                                                                 |

### 2.2 Role × permission matrix

Columns:

| Code | Role                |
| ---- | ------------------- |
| NA   | Network Admin       |
| NAu  | Network Auditor     |
| SUP  | Support Agent       |
| OO   | Org Owner           |
| OA   | Org Admin           |
| OV   | Org Viewer          |
| CO   | Coordinator         |
| OP   | Onboarding Operator |
| CM   | Campaign Operator   |
| UV   | Unit Viewer         |
| PA   | Participant         |

| Permission            | NA  | NAu | SUP | OO  | OA  | OV  | CO  | OP  | CM  | UV  | PA  |
| --------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `self:account`        | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | ✓   |
| `self:items`          | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | ✓   |
| `self:actions`        | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   | ✓   |
| `participant:read`    | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | ✓   | -   |
| `participant:manage`  | -   | -   | -   | -   | -   | -   | ✓   | ✓   | -   | -   | -   |
| `participant:retire`  | ✓   | -   | -   | -   | -   | -   | ✓   | -   | -   | -   | -   |
| `participant:export`  | -   | -   | -   | ✓   | ✓   | -   | ✓   | -   | ✓   | -   | -   |
| `participant:decrypt` | -   | -   | -   | -   | -   | -   | ✓   | -   | -   | -   | -   |
| `campaign:run`        | -   | -   | -   | -   | -   | -   | ✓   | -   | ✓   | -   | -   |
| `org:read`            | ✓   | ✓   | -   | ✓   | ✓   | ✓   | -   | -   | -   | -   | -   |
| `org:manage`          | -   | -   | -   | ✓   | ✓   | -   | -   | -   | -   | -   | -   |
| `org:govern`          | ✓   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   |
| `unit:configure`      | -   | -   | -   | ✓   | ✓   | -   | ✓   | -   | -   | -   | -   |
| `unit:govern`         | ✓   | -   | -   | ✓   | ✓   | -   | -   | -   | -   | -   | -   |
| `access:read`         | ✓   | ✓   | -   | ✓   | ✓   | -   | ✓   | -   | -   | -   | -   |
| `access:manage`       | ✓   | -   | -   | ✓   | ✓   | -   | ✓   | -   | -   | -   | -   |
| `role:manage`         | ✓   | -   | -   | ✓   | -   | -   | -   | -   | -   | -   | -   |
| `access:administer`   | ✓   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   |
| `audit:read`          | ✓   | ✓   | -   | ✓   | -   | -   | -   | -   | -   | -   | -   |
| `network:configure`   | ✓   | -   | -   | -   | -   | -   | -   | -   | -   | -   | -   |
| `user:administer`     | ✓   | -   | ✓   | -   | -   | -   | -   | -   | -   | -   | -   |

Org Owner and Org Admin have no PII permissions by default, following IAM spec D3. This is an open question. Ownership transfer is the one action inside `org:manage` that only the current Org Owner may perform.

### 2.3 Custom roles

| Rule                          | Detail                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Built only from the catalogue | A custom role is a name, a description and a set of permission keys. Unknown keys are rejected.                                                                                                                                                        |
| Owner scope                   | A custom role belongs to `platform` or to one org. Org custom roles are visible and bindable only inside that org and its units.                                                                                                                       |
| Who can author                | `role:manage` at the owner scope                                                                                                                                                                                                                       |
| Content ceiling               | Platform roles: any non-`SVC` permission. Org roles: only permissions in the org's entitlement, and never platform-only ones.                                                                                                                          |
| Org entitlement               | The permission set an org may use, set by Network Admin (`access:administer`). It defaults to the union of the org and unit system roles. Removing a permission strips it from the org's custom roles and audits the change.                           |
| Grant ceiling                 | Assigning a role needs `access:manage` at the target scope, and every permission in the role must be within the granter's ceiling. Platform: the full catalogue. Org managers: the org entitlement. Unit managers: their own permissions at that unit. |
| No self-grant                 | Nobody can create or change their own bindings                                                                                                                                                                                                         |
| Last owner                    | Removing or demoting the only Org Owner is refused; transfer ownership instead                                                                                                                                                                         |
| Edits apply live              | Editing a custom role updates every holder, bumps the role version and writes an audit row                                                                                                                                                             |
| Deletion                      | Refused while bindings exist, unless the holders are reassigned in the same request                                                                                                                                                                    |

### 2.4 Catalogue changes

| Change                                     | Procedure                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add a permission                           | Add the constant, list the operations it covers, and update the system roles that should hold it. The deploy seeds it. Custom roles are unchanged until an author opts in.                 |
| Add an operation to an existing permission | Add it to the permission's covered operations. Every holder gets it, so only do this when every role holding the permission should have the new operation. Otherwise add a new permission. |
| Rename                                     | Not allowed. Add a new key, alias the old one for one release, then deprecate the old one.                                                                                                 |
| Deprecate                                  | Mark `deprecated_at`. The next deploy removes it from custom roles and entitlements, with one audit row per affected role.                                                                 |
| Split                                      | The new key goes to every role that held the parent, so nobody loses access at deploy                                                                                                      |
