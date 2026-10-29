# Organisation `known_as` with levels

**Date:** 2026-10-29
**Branch:** `feat/org-known-as` (builds on `org-known-as.md` and `org-nesting-minimum.md`).
**Status:** In progress.

---

## 1. What this adds to the per-org design

`org-known-as.md` stays: each org stores its own `known_as` key, and the network admin picks it from the config list. This plan adds:

| Addition           | Detail                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A level per value  | Each config value carries a `level` (1 = directly under the network). Several values can share a level.                                                                     |
| Parent with level  | Changing an org's `known_as` to a level-N value also sets its parent: an org at level N-1, or the network for level 1.                                                      |
| Registration value | A new org gets the value one level below its parent when exactly one value sits at that level; otherwise `default`.                                                         |
| Organisations page | The network admin's Organisations page shows the configured levels, the orgs awaiting approval (approve / reject) and the whole network as a tree; each org opens its page. |

Not in scope: renaming labels or changing levels from the UI (config only), moving an org that has child orgs, limits.

## 2. Decisions

| #   | Question                   | Decision                                                                                                    |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| V1  | Level config               | A `level` number on each value.                                                                             |
| V2  | Parent for a level-N value | An active, non-Default org whose `known_as` is at level N-1; the network for level 1. Never the org itself. |
| V3  | Org with child orgs        | Its `known_as` and parent cannot change (409) until its children are moved.                                 |
| V4  | Self-registered org        | The value at the parent's level + 1 when exactly one exists; else `default`.                                |
| V5  | An org's level             | The level of its `known_as` value; the network is 0; a key no longer configured has no level.               |

## 3. Config

```yaml
aggregator:
  organisation:
    known_as:
      values:
        - { key: state, label: State, level: 1 }
        - { key: district, label: District, level: 2 }
        - { key: aggregator, label: Aggregator, level: 3 }
      default: aggregator
```

Boot check: keys unique and snake_case; `default` is one of `values`; levels run from 1 with no gap. Absent block: one value, `aggregator`, level 1.

## 4. Database

Migration `0032` (per-org `known_as`, from `org-known-as.md`) is unchanged. `parent_id` already exists; the store gains an update of it.

## 5. API

| Change                                                                                                                                                                                                    | Where                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `PATCH /v1/org/metadata/update/:id` takes `known_as` and `parent_id` (network admin only). A level change needs `parent_id`; the parent must be at level N-1 (V2); an org with children answers 409 (V3). | `v1-org.ts`                    |
| `OrgSchema.level` (V5).                                                                                                                                                                                   | shared-primitives, `toWireOrg` |
| `GET /v1/org/hierarchy` (network admin, read-only): the network `{id, name}` and each level with its values and pending + active org counts.                                                              | `v1-org.ts`                    |
| Org create: `known_as` from V4. `GET /v1/orgs/parents` adds `child_known_as_label`.                                                                                                                       | `aggregator-orgs.ts`           |
| Store: `UpdateOrgPatch.parentId`, `hasChildren(id)`, `countByKnownAs()`.                                                                                                                                  | `organisation-store/*`         |

## 6. Web

| Change                                                                                                                                                                                                                                           | Where                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Org form (network admin): Known as dropdown showing levels; when the level changes, a required "Parent organisation" dropdown of valid parents. Read-only with a note when the org has children.                                                 | `OrgEditForm.tsx`, org page                                                    |
| `/console/orgs` (network admin): a Levels strip (Level 0 network → each level's values and org counts), "Awaiting approval" with Approve / Reject, and the Network tree linking to each org. Replaces the flat list; no separate hierarchy page. | `console/orgs/page.tsx`, `OrgLevels.tsx`, `OrgsTable.tsx`, `ChildOrgsTree.tsx` |
| Registration hint: "Your organisation will be known as …".                                                                                                                                                                                       | `OrgRegisterForm.tsx`                                                          |
