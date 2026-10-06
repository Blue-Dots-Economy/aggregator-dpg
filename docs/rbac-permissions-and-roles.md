# RBAC Catalogue — Capabilities, PermissionSets & Roles

## Summary

The fixed list of capabilities, the default PermissionSets given to organisations, and the four roles given to people. [rbac-design.md](rbac-design.md) covers how they are stored and enforced.

## Highlights

| Item             | Value                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Capabilities     | 13, fixed in code, each with a stable `resource.action` ID                                                                 |
| PermissionSets   | A named list of capabilities given to an organisation. 3 defaults; organisations can compose their own for their children. |
| Roles            | 4, fixed: Admin, Coordinator, Viewer, plus PII Access as an add-on                                                         |
| Effective access | The organisation's PermissionSet ∩ the person's roles, over that organisation and everything beneath it                    |
| Sensitive data   | No default role includes personal data. It needs PII Access, which expires and is audited.                                 |

## Glossary

| Term          | Meaning                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| Profile       | A seeker's or provider's record on the network, with the person's details                                    |
| Organisation  | A node in the network tree: the Network Admin organisation at the root, aggregators beneath it, at any depth |
| Capability    | One thing that can be done, e.g. `profiles.verify`                                                           |
| PermissionSet | A named list of capabilities that an organisation holds                                                      |
| Role          | What a person may do inside their organisation                                                               |
| Member        | A person with one or more roles in an organisation                                                           |

---

## 1. Capabilities

| ID                       | Label                 | Lets the holder                                                                     | Notes                                                      |
| ------------------------ | --------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `profiles.view`          | View profiles         | See masked profiles, dashboards and metrics in the subtree                          | -                                                          |
| `profiles.export`        | Export profiles       | Download masked profile lists                                                       | Data leaving the system                                    |
| `profiles.view_pii`      | View personal data    | See and export decrypted personal details                                           | Audited on every use                                       |
| `profiles.onboard`       | Onboard profiles      | Registration links, bulk uploads, forms; edit, pause and unpause onboarded profiles | Every organisation holds it                                |
| `profiles.verify`        | Verify profiles       | Mark a seeker or provider as verified                                               | -                                                          |
| `profiles.retire`        | Retire profiles       | Retire a profile: removes personal data, cancels connections                        | Irreversible                                               |
| `profiles.move`          | Move profiles         | Move profiles to another aggregator                                                 | Comes with Super Aggregator status; never granted directly |
| `profiles.act_on_behalf` | Act on behalf         | Connect or apply on a profile owner's behalf                                        | In no default set; used by service clients today           |
| `campaigns.run`          | Run campaigns         | Send email and voice campaigns to profiles in the subtree                           | Uses decrypted contacts; audited                           |
| `orgs.onboard`           | Onboard organisations | Invite and approve child organisations; compose PermissionSets for them             | -                                                          |
| `orgs.block`             | Block organisations   | Suspend or remove a child organisation                                              | Not grantable until built                                  |
| `org.manage`             | Manage organisation   | Edit the organisation's profile; invite and remove members; assign roles            | Never on yourself                                          |
| `network.administer`     | Administer network    | Network configuration and schemas, service clients, audit log, user bans            | Network Admin organisation only                            |

---

## 2. PermissionSets for organisations

An organisation's parent chooses its PermissionSet when it invites or approves it.

| Capability               | Network | Super Aggregator | Aggregator |
| ------------------------ | ------- | ---------------- | ---------- |
| `profiles.view`          | ✓       | ✓                | ✓          |
| `profiles.export`        | ✓       | ✓                | ✓          |
| `profiles.view_pii`      | -       | ✓                | ✓          |
| `profiles.onboard`       | ✓       | ✓                | ✓          |
| `profiles.verify`        | ✓       | ✓                | -          |
| `profiles.retire`        | ✓       | ✓                | ✓          |
| `profiles.move`          | ✓       | ✓                | -          |
| `profiles.act_on_behalf` | -       | -                | -          |
| `campaigns.run`          | -       | ✓                | ✓          |
| `orgs.onboard`           | ✓       | ✓                | -          |
| `orgs.block`             | -       | -                | -          |
| `org.manage`             | ✓       | ✓                | ✓          |
| `network.administer`     | ✓       | -                | -          |

The Network set leaves out personal data. The network operator governs the network; it does not read seekers' and providers' details.

Custom PermissionSets:

| Rule    | Detail                                                                                        |
| ------- | --------------------------------------------------------------------------------------------- |
| Who     | Any organisation holding `orgs.onboard`, for its own children                                 |
| Content | Any capabilities the composing organisation itself holds. `profiles.onboard` is always added. |
| Example | "Verifier only" = `profiles.view`, `profiles.onboard`, `profiles.verify`                      |
| Changes | Editing a set updates every organisation holding it, and is audited                           |

---

## 3. Roles for people

Roles are fixed. A person can hold more than one; their access is the union, capped by the organisation's PermissionSet.

| Role                | Capabilities                                                            | Typical holder                                                                              |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Admin               | Everything in the organisation's set, except `profiles.view_pii`        | Organisation owner, Network Admin                                                           |
| Coordinator         | `profiles.view`, `profiles.onboard`, `profiles.verify`, `campaigns.run` | Field and onboarding staff                                                                  |
| Viewer              | `profiles.view`                                                         | Supervisors, auditors, funders                                                              |
| PII Access (add-on) | `profiles.view_pii`                                                     | Named people who need personal details. Held alongside another role; expires after 90 days. |

| Capability           | Admin | Coordinator | Viewer | PII Access |
| -------------------- | ----- | ----------- | ------ | ---------- |
| `profiles.view`      | ✓     | ✓           | ✓      | -          |
| `profiles.export`    | ✓     | -           | -      | -          |
| `profiles.view_pii`  | -     | -           | -      | ✓          |
| `profiles.onboard`   | ✓     | ✓           | -      | -          |
| `profiles.verify`    | ✓     | ✓           | -      | -          |
| `profiles.retire`    | ✓     | -           | -      | -          |
| `profiles.move`      | ✓     | -           | -      | -          |
| `campaigns.run`      | ✓     | ✓           | -      | -          |
| `orgs.onboard`       | ✓     | -           | -      | -          |
| `org.manage`         | ✓     | -           | -      | -          |
| `network.administer` | ✓     | -           | -      | -          |

A ✓ applies only where the organisation's PermissionSet also holds the capability. An Admin of an Aggregator, for example, has no `orgs.onboard`.

---

## 4. Rules

| Rule                  | Detail                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Effective access      | Organisation's PermissionSet ∩ the person's roles. Applies to that organisation and every organisation beneath it. |
| Subset rule           | A child's PermissionSet can never exceed its parent's. Checked when the grant is made.                             |
| Onboarding always on  | `profiles.onboard` is in every organisation's set and cannot be removed. Roles still decide which people use it.   |
| Earned capability     | `profiles.move` is held only while the organisation has Super Aggregator status                                    |
| Not yet grantable     | `orgs.block` is listed but refused until it is built                                                               |
| Separation of duties  | Admins grant PII Access to others but do not hold it by default. Nobody changes their own roles.                   |
| Last Admin            | An organisation's last Admin cannot be removed                                                                     |
| Review                | PII Access expires after 90 days unless renewed. Every grant, change, revoke and use of personal data is audited.  |
| Seekers and providers | Manage their own account, profiles and connections through fixed self-service rules, outside roles                 |

---

## 5. Changing the catalogue

| Change                           | Procedure                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Add a capability                 | Add it in code with its routes (Appendix A) and decide which default sets and roles hold it. The deploy seeds it. |
| Add an operation to a capability | Only if every holder of the capability should get it; otherwise add a new capability                              |
| Rename                           | Not allowed. Add a new ID, keep the old one as an alias for one release, then remove it.                          |
| Remove                           | Mark deprecated; the next deploy removes it from every set and audits each change                                 |

---

## Appendix A. Capability → routes

| Capability               | signals-dpg                                                                                                                   | aggregator-dpg                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `profiles.view`          | `GET /admin/participant`, `GET /aggregator/dashboard`                                                                         | `GET /v1/dashboard`, `/v1/onboarding/*`, `GET /v1/links*`, `GET /v1/bulk-uploads*`, `GET /v1/campaign/*` |
| `profiles.export`        | `GET /aggregator/dashboard/export`                                                                                            | `GET /v1/dashboard/export`                                                                               |
| `profiles.view_pii`      | `POST /admin/participant/decrypt`                                                                                             | `POST /v1/dashboard/export/profiles`, `POST /v1/campaign/export`                                         |
| `profiles.onboard`       | `POST /admin/participant`, `POST /item/create` (`created_by`), `PATCH /item/:itemId`, `POST /item/lifecycle` (pause, unpause) | `/v1/links*` writes, `/v1/bulk-uploads*` writes, including template and `errors.csv`                     |
| `profiles.verify`        | No route yet                                                                                                                  | No route yet                                                                                             |
| `profiles.retire`        | `POST /item/lifecycle` (retire, on a profile the caller does not own)                                                         | -                                                                                                        |
| `profiles.move`          | No route yet                                                                                                                  | No route yet                                                                                             |
| `profiles.act_on_behalf` | `POST /action/perform*` with `acting_as_user_id`                                                                              | -                                                                                                        |
| `campaigns.run`          | -                                                                                                                             | `POST /v1/campaign/email`, `POST /v1/campaign/voice`, `POST /api/dashboard/actions`                      |
| `orgs.onboard`           | -                                                                                                                             | `/admin/v1/orgs/*`, `/admin/v1/aggregator-registrations/{read,decision,renew}/:id`, PermissionSet editor |
| `orgs.block`             | No route yet                                                                                                                  | No route yet                                                                                             |
| `org.manage`             | -                                                                                                                             | `PATCH /v1/aggregators/profile/me`, `POST /admin/v1/invites`, members and roles pages                    |
| `network.administer`     | `POST /network/refetch_schemas`, audit log                                                                                    | Service-client and network settings pages                                                                |

## Appendix B. Access that is not a capability

| Access                                        | Operations                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public (rate limits, Turnstile, signed links) | signals: `/health/*`, `/auth/config`, `/auth/session*`, `/auth/signup`, `/auth/u18-precheck`, `/network/schema*`, `/network/item/fetch`, `/network/item/markers`, `/network/item/discover`, `/consent/status-by-identifier`, `/consent/u18/signup/guardian*`. aggregator: `/health/*`, `/v1/aggregator-config`, `/v1/participant-consent`, `/public/v1/aggregators/:orgSlug/*` |
| Any signed-in person                          | Own account (`GET /auth/me`), support requests                                                                                                                                                                                                                                                                                                                                 |
| Seeker or provider, own data only             | `/user/domains`, `/consent/*`, `/item/*` on own profiles, `/action/*`, `/event/*`, `/match-score/calculate`                                                                                                                                                                                                                                                                    |

## Appendix C. Service clients

Service clients are machine identities. People never hold these.

| Client                            | Allowed                                                                                                                                          | Condition                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `aggregator-dpg` (API and worker) | `profiles.view`, `profiles.export`, `profiles.view_pii`, `profiles.onboard`; syncing organisations into Signals; cleaning up stale registrations | Profile calls carry the acting person; effective = client ∩ person |
| `aggregator-bff`                  | Registration and organisation sign-up forms, organisation list                                                                                   | No profile data                                                    |
| `voice-dpg` (Raya)                | `profiles.act_on_behalf`, own-data access                                                                                                        | Only for the OTP-verified caller                                   |
| `campaign-manager`                | `profiles.view`, `profiles.view_pii`, `campaigns.run`, network-wide non-PII dump                                                                 | Intersects with the operator's access, except the dump             |
| Peer instances                    | Federated reads and cross-instance actions                                                                                                       | Signed peer requests                                               |
