# Organisation `known_as`: implementation design

**Date:** 2026-10-28
**Branch:** to be cut from `feature` (or `feat/rbac-edge-enforcement`, which contains it).
**Status:** Superseded by `org-known-as-levels.md` (known_as by hierarchy level). The per-org design below is implemented on the branch, not committed, and will be replaced.
**Plan:** `user-org-target-model.md` (the `known_as` row: "Mechanism ships; values unset"), `apis-phase-5.md` §3.2–3.3 (`OrgSchema.known_as`, the metadata update and search filter), `organisation-phase-3-implementation.md` D3-9 (deferred to Phase 5).

---

## 1. Scope

The network admin views and changes each aggregator org's **"known as"** label, picked from a per-instance list of values. The default value is **Aggregator**.

**In scope:** the config list, the column, the wire field, the metadata update, the search filter, the console form and table, tests, docs.

**Not in scope:** re-parenting orgs (every org sits directly under the root; `max_depth` / `max_children` limits stay deferred), renaming the "Aggregator" tier across the UI, and Signals-side changes.

## 2. What the code shows today

| Area                                                                       | State on `feature` (`8c66c99f`)                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `organisations` table (`packages/db-schema/src/schema.ts`)                 | No `known_as` column. Latest migration `0031_rbac_seed.sql`.                                                        |
| Wire `OrgSchema` (`packages/shared-primitives/src/user-org/index.ts`)      | No `known_as`.                                                                                                      |
| `PATCH /v1/org/metadata/update/:id` (`apps/api/src/routes/v1-org.ts`)      | Edits `name` (network admin only), `url`, `locations`, `legal_name`, `gst_number`. Default org and root answer 409. |
| `POST /v1/org/search`                                                      | Filters `status`, `name_prefix` only.                                                                               |
| Config (`packages/network-config/src/interface.ts` `AggregatorYamlSchema`) | No `organisation` block.                                                                                            |
| Console (`OrgEditForm.tsx`, `OrgsTable.tsx`)                               | No label field or column. `canRename` already gates admin-only fields.                                              |
| Revert path (`existing-instance-migration.md`)                             | Already lists `known_as` as dropped on revert (harmless).                                                           |

## 3. Design

### 3.1 Config: the allowed values

New optional block in `AggregatorYamlSchema`:

```yaml
aggregator:
  organisation:
    known_as:
      default: aggregator
      values:
        - { key: aggregator, label: Aggregator }
        - { key: training_partner, label: Training Partner }
```

| Rule         | Detail                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Absent block | Resolves to `values: [{ key: aggregator, label: Aggregator }]`, `default: aggregator`. Existing deployments are unchanged.  |
| Key format   | `^[a-z][a-z0-9_]*$`, unique within `values`.                                                                                |
| Boot check   | `default` must be one of `values`; otherwise config validation fails with a `ConfigError`.                                  |
| Stored value | The **key**. The label lives in config only, so a label can be renamed without a data migration.                            |
| Removed key  | Rows keep it. The API returns the raw key with a `null` label; the UI shows the key. Only writes validate against the list. |

Documented in `config/aggregator.config.example.yaml`.

### 3.2 Database

Migration `0032_org_known_as.sql`, following the 0028–0031 frame (lock/statement timeouts, role switch):

```sql
ALTER TABLE organisations ADD COLUMN known_as text NOT NULL DEFAULT 'aggregator';
```

- Postgres applies a constant default without rewriting the table, so existing rows get `aggregator` at once.
- No database enum or CHECK: the list differs per instance and is validated on write.
- The root also holds the column value; the API never exposes it (§3.3).
- `organisations_lock` needs no change.

### 3.3 API

| Change                                                                                                                                                                 | Where                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `knownAs: string` on `Organisation`, `CreateOrgInput`, `UpdateOrgPatch`; mapped in postgres, memory and testing stores                                                 | `apps/api/src/services/organisation-store/*`                                           |
| `known_as: z.string().nullable()` and `known_as_label: z.string().nullable()` on `OrgSchema`; both `null` for the root                                                 | `packages/shared-primitives/src/user-org/index.ts`, `toWireOrg` in `console-shared.ts` |
| `known_as` on `OrgMetadataUpdateRequestSchema` (key format only; membership is checked in the handler against config)                                                  | same                                                                                   |
| Handler: network admin only (`403 FORBIDDEN` otherwise, like `name`); key not in config → `400 VALIDATION_ERROR` naming the field; Default org / root → existing `409` | `v1-org.ts`                                                                            |
| `FIELD_LABELS.known_as = 'the "known as" label'`, so the owner gets the existing admin-action email; field listed in the `console.org.update` log                      | `v1-org.ts`                                                                            |
| `filter.known_as` on `OrgSearchRequestSchema`, applied in the store query                                                                                              | shared-primitives, organisation-store                                                  |
| Org self-registration and console create pass the config `default` explicitly (the DB default only covers rows created before this change)                             | `aggregator-orgs.ts` (`orgStore.create`)                                               |
| `GET /v1/aggregator-config` returns `organisation.known_as: { default, values }` so the web app builds the dropdown from server-side config                            | `aggregator-config.ts`                                                                 |
| Regenerate `openapi.json`                                                                                                                                              | spec-drift CI check                                                                    |

No new RBAC capability: the route already requires `org.manage` or `orgs.onboard`, and the network-admin check sits in the handler, like `name`.

### 3.4 Web console

| Change                                                                                                                               | Where                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| "Known as" `<select>` in the details form, editable when `canRename` (network admin); plain text otherwise and in the read-only view | `components/console/OrgEditForm.tsx`                                      |
| Options passed down from the page, read from `/v1/aggregator-config` on the server                                                   | `app/(console)/console/orgs/[id]/page.tsx`                                |
| "Known as" column in the org list; optional filter on `/console/orgs`                                                                | `components/console/OrgsTable.tsx`, `app/(console)/console/orgs/page.tsx` |
| Strings `org.known_as`, `org.known_as_admin_only`, `orgs.col_known_as` in `console`                                                  | `apps/web/src/i18n/messages/{en,hi,kn}.json`                              |

The BFF proxy `api/console/org/metadata/[id]/route.ts` forwards the body as is; no change expected beyond a test.

## 4. Steps

| #   | Step                                                                                      | Verify                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Config schema + default + boot check + example YAML                                       | `pnpm --filter @aggregator-dpg/network-config test`                                                                                                |
| 2   | Migration 0032 + `schema.ts`                                                              | `pnpm --filter @aggregator-dpg/db-schema test`; migrate a local DB, existing orgs read `aggregator`                                                |
| 3   | Store fields, create path, search filter                                                  | organisation-store tests (memory + postgres)                                                                                                       |
| 4   | Wire schemas, `toWireOrg`, PATCH handler, search route, aggregator-config, `openapi.json` | `pnpm --filter @aggregator-dpg/api test`; spec-drift check                                                                                         |
| 5   | Console form, table, filter, i18n                                                         | `pnpm --filter @aggregator-dpg/web test`                                                                                                           |
| 6   | Whole repo                                                                                | `pnpm -w typecheck`, `pnpm -w lint`, `pnpm dep-check`, coverage ≥ 70%                                                                              |
| 7   | Local stack                                                                               | network admin changes an org's label; list and detail show it; owner sees it read-only and receives the notice; a PATCH from the owner answers 403 |
| 8   | Docs                                                                                      | `apps/api/CLAUDE.md` organisations section; mark the item done in `apis-phase-5.md`                                                                |

## 5. Tests

| Area        | Cases                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config      | absent block → default list; `default` not in `values` → error; duplicate or malformed key → error                                                       |
| PATCH route | network admin sets a valid key → 200 with label; owner sends `known_as` → 403; unknown key → 400; Default org / root → 409; owner notice names the field |
| Search      | `filter.known_as` narrows results; still intersected with the actor's scope                                                                              |
| Wire        | root returns `known_as: null`; a removed key returns the key with `known_as_label: null`                                                                 |
| Create      | self-registered org gets the config default                                                                                                              |
| Web         | admin sees an enabled select; owner sees text; unchanged value sends no PATCH field                                                                      |

## 6. Rollout

- Additive migration; no backfill script. Existing instances read `aggregator` with no config change.
- If an instance uses `user-org-migrate.sh` / the train, confirm whether 0032 runs through it or through normal boot migrations, and add it to `inspect`'s expected level.
- A revert to a pre-0032 image drops the column's meaning only; `existing-instance-migration.md` already lists `known_as` as dropped on revert.

## 7. Open decisions (recommended defaults, overturn as needed)

| #   | Question                                                   | Default taken                                                                                |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| K1  | Per-org label, or a rename of the whole "Aggregator" tier? | **Per-org label** from the list.                                                             |
| K2  | Who edits it?                                              | **Network admin only.** Org owners see it read-only and do not pick it at self-registration. |
| K3  | Is the Default org's label editable?                       | **No.** It stays read-only at the config default, like its other details.                    |
| K4  | Does the root show a label?                                | **No.** `known_as: null` on the wire, hidden in the UI.                                      |
| K5  | Values per network (blue_dot, purple_dot, …)?              | **Ship only `Aggregator`.** Each instance adds values in its `aggregator.config.yaml`.       |
