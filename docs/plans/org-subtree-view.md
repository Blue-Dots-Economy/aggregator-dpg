# Org owners see the organisations below theirs (read-only)

**Date:** 2026-10-29
**Branch:** `feat/org-known-as` (builds on `org-known-as-levels.md`).
**Status:** Implemented on `feat/org-known-as` (not committed); checked on the local stack as the Karnataka (State) and Mysuru (District) owners.

---

## 1. Problem

An owner reaches only the orgs it owns (`services/authz/scope.ts`). A State owner whose State org has no coordinators of its own sees an empty Coordinators page, cannot open a District's page (404), and has no Organisations page, although Districts with coordinators sit under it.

## 2. Decisions

| #   | Question                       | Decision                                                                                                                                                   |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | What can an owner do below?    | **View only.** Lists, detail pages and counts for every org and coordinator below its own. Approve, edit, invite and roles stay with each org's own owner. |
| S2  | Contacts of coordinators below | **Masked**, whatever the RBAC mode. Only coordinators of the owner's own orgs show unmasked (as today).                                                    |
| S3  | Where the owner sees it        | The **Organisations** page, rooted at its own org(s), with no approval section and no levels. Coordinators filter lists the subtree.                       |

RBAC is unchanged: no ancestor chains, no new role or permission, no edge change. The routes involved already accept `org.manage`, which an owner holds.

## 3. Two kinds of reach

| Reach      | Who              | Contains                                | Used by                                                     |
| ---------- | ---------------- | --------------------------------------- | ----------------------------------------------------------- |
| **Manage** | as today         | the orgs the owner owns                 | every write: decisions, edits, invites, roles, org metadata |
| **View**   | new, owners only | owned orgs **and every org below them** | reads: org search and read, coordinator search and read     |

The network admin already reaches every org; nothing changes for it.

## 4. API

| Change                                                                                                                                                                        | Where                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `viewableOrgIds(actor)`: owned ids plus their descendants (one recursive query). `null` for the network admin.                                                                | `services/authz/scope.ts`, store `descendantIds(ids)` |
| `manageableOrgIds(..., 'view')` starts from view reach instead of owned reach.                                                                                                | `services/authz/manage-scope.ts`                      |
| `GET /v1/org/read/:id` and `POST /v1/org/search` use view reach. `PATCH /v1/org/metadata/update/:id`, decision and repair keep manage reach (an org below answers 404 there). | `routes/v1-org.ts`                                    |
| `POST /v1/user/search`, `GET /v1/user/read/:id`: view reach; a coordinator outside the owner's own orgs is always masked (S2).                                                | `routes/v1-user.ts`                                   |
| Every read of an org or coordinator below logs `relation: 'below'` alongside actor and target ids.                                                                            | same                                                  |
| Coordinator decision, metadata, invite, roles: unchanged (manage reach).                                                                                                      | —                                                     |

## 5. Web

| Change                                                                                                                                              | Where                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Sidebar: **Organisations** for owners too.                                                                                                          | `ConsoleSidebar.tsx`                 |
| Organisations page for an owner: one tree per topmost owned org, with everything below; names link to org pages. No "Awaiting approval", no Levels. | `console/orgs/page.tsx`              |
| Org page of an org below: read-only details, the child tree, "View coordinators"; no edit, repair or roles. Decided by "is this org in `me.orgs`".  | `console/orgs/[id]/page.tsx`         |
| Coordinators page: the Organisation filter lists the subtree; rows from orgs below show masked contacts (from the API).                             | `console/coordinators/page.tsx`      |
| Coordinator page of a coordinator below: read-only, no decision / domain / role actions.                                                            | `console/coordinators/[id]/page.tsx` |
| Home: own orgs as today, plus a line "N organisations and M coordinators below yours" linking to the Organisations page.                            | `console/page.tsx`                   |

## 6. Tests

| Area  | Cases                                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------- |
| Scope | view reach = owned + descendants; a sibling's subtree excluded; network admin unchanged                                    |
| Org   | State owner reads a District (200) and an Agg below it; not a sibling State (404); District metadata update / decision 404 |
| User  | State owner lists District coordinators, masked in every RBAC mode; reads one masked; decision on it 404                   |
| Web   | owner sidebar shows Organisations; owner tree rooted at own org; read-only org and coordinator pages for orgs below        |

## 7. Local check

As the Nest State Org owner: Organisations shows Nest State Org → District Org → Agg Org and District Two; Coordinators lists the District's coordinators with masked email and phone; opening one shows no actions; approving it through the API answers 404. As the District owner, nothing above the District is visible.
