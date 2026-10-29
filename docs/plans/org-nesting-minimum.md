# Organisation nesting: minimum end-to-end

**Date:** 2026-10-29
**Branch:** `feat/org-known-as` (the parent picker shows the `known_as` label).
**Status:** Implemented on `feat/org-known-as` (not committed). Local stack check (§6) pending.
**Context:** `phase-5-gaps.md` §4 (org hierarchy). This is the smallest slice that lets a State → District → Aggregator chain be registered and viewed. The rest of §4 is planned separately.

---

## 1. Scope

| In scope                                                      | Not in scope                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| API accepts an optional parent on org self-registration       | Moving an org (no move route; `parent_id` DB lock, gap 3)              |
| Parent picker (required) in the org self-registration form    | Depth / child limits (`ORG_DEPTH_LIMIT`, `ORG_CHILD_LIMIT`)            |
| Read-only list of all descendant orgs on the owner's org page | Parent owners managing children; RBAC ancestors stay `[root]`          |
| Parent shown on the org page and in the review email          | Approval by the parent's admins (stays network admin)                  |
|                                                               | Keycloak sub-groups; `known_as` rules on which org may sit under which |

## 2. Decisions

| #   | Question                                       | Decision                                                                                                                                                                            |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | Which orgs are "child organisations"?          | All descendants, not only direct children.                                                                                                                                          |
| N2  | Who approves an org registered under a parent? | The network admin, unchanged.                                                                                                                                                       |
| N3  | Is the parent required?                        | Required in the UI. Optional in the API: absent means the network root, as today. Not a breaking change.                                                                            |
| N4  | Where does the owner see the list?             | A "Child organisations" section on `/console/orgs/[id]`.                                                                                                                            |
| N5  | Which orgs can be a parent?                    | The root, or an active aggregator org that is not the Default org.                                                                                                                  |
| N6  | Owner access to a child org                    | None beyond the list. Opening a child's page answers 404 for an owner. RBAC ancestors are unchanged.                                                                                |
| N7  | Parent deactivated while a child is pending    | No approval-time check. Create locks the parent row (`FOR SHARE`), and no route moves an active org out of `active` today (deactivate, #851, is deferred). Add the check with #851. |

## 3. API

| Change                                                                                                                                                                      | Where                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `CreateOrgInput.parentId` (optional; the root when absent). `Organisation.parentId`, `parentName`.                                                                          | `apps/api/src/services/organisation-store/*`           |
| `parent_id` optional on `POST /v1/orgs/create`. Present: must be the root or an active non-Default aggregator org, else `400` with `fields.parent_id`.                      | `apps/api/src/routes/aggregator-orgs.ts`               |
| `GET /v1/orgs/parents` (service auth): the root (network name, `is_root: true`) then active non-Default orgs with `known_as_label`.                                         | same; `routes:dump`                                    |
| `parent_id`, `parent_name` on `OrgSchema` (`null` for the root).                                                                                                            | `packages/shared-primitives/src/user-org`, `toWireOrg` |
| `filter.descendants_of` on `POST /v1/org/search`: the named org must be in the caller's reach (else an empty page); returns its descendants, ignoring the normal reach set. | `apps/api/src/routes/v1-org.ts`, store `search`        |
| Review email names the parent.                                                                                                                                              | `apps/api/src/services/org-registration-notify.ts`     |
| Regenerate `openapi.json`.                                                                                                                                                  | —                                                      |

## 4. Web

| Change                                                                                                                                     | Where                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| BFF proxy `GET /api/orgs/parents`.                                                                                                         | `apps/web/src/app/api/orgs/parents/route.ts`                                                     |
| Required "Parent organisation" select above the form; options "Name (Known as)", root first. Always sends `parent_id`.                     | `apps/web/src/app/(public)/register/OrgRegisterForm.tsx`                                         |
| "Child organisations" table (name, known as, parent, status, counts); rows link only for the network admin. "Parent" line on the org page. | `apps/web/src/app/(console)/console/orgs/[id]/page.tsx`, `components/console/ChildOrgsTable.tsx` |
| Strings in `en`, `hi`, `kn`.                                                                                                               | `apps/web/src/i18n/messages/*.json`                                                              |

## 5. Tests

| Area    | Cases                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------- |
| Store   | create under a parent; create without one → root; descendants across three levels                   |
| Create  | no `parent_id` → root; unknown, Default, pending or inactive parent → 400; root or active org → 201 |
| Parents | root first, Default excluded, `known_as_label` set                                                  |
| Search  | `descendants_of` out of reach → empty; owner sees the subtree; network admin sees any subtree       |
| Web     | picker required and sends `parent_id`; child table plain text for an owner, links for the admin     |

## 6. Local check

1. `known_as` values `state`, `district`, `aggregator` in the instance config.
2. Register State Org (parent: Network). Approve; set Known as = State.
3. Register District Org under State Org. Approve; set District.
4. Register Agg Org under District Org. Approve.
5. State owner sees District and Agg read-only, with parents. District owner sees Agg. Agg owner sees none. An owner opening a child's URL gets 404.
