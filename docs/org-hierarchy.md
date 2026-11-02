# Organisation hierarchy

Aggregator orgs form a tree under the network root. Each org also carries a `known_as` value, which says what the org is known as in the instance ("State", "District", "Aggregator"). The two are independent: where an org sits comes from its parent, not from its `known_as`.

## Depth

- `organisations.depth`: the root is 0, an org directly under it is 1, a child of a depth-N org is N+1.
- The store sets `depth` on create and on move. A `BEFORE INSERT` trigger fills it from the parent when a writer does not send it. A CHECK ties depth 0 to the root.
- `scripts/sql/organisation-verify.sql` (gate V9) checks that every org's depth is its parent's depth + 1.

## Limits

Set in the instance config under `aggregator.organisation.hierarchy`:

| Setting          | Meaning                                                                               | Default |
| ---------------- | ------------------------------------------------------------------------------------- | ------- |
| `max_depth`      | The deepest an aggregator org can be. 1 keeps every org directly under the network.   | 1       |
| `max_children`   | The most direct child orgs any org can have, the root included. Unset means no limit. | unset   |
| `max_total_orgs` | The most aggregator orgs in the instance.                                             | 50      |

- Counts include `pending` and `active` orgs. Rejected and deleted orgs do not count.
- The Default org is not counted, is never a parent and is never moved.
- An org can take a child when it is the root or an active non-Default org, its depth is below `max_depth`, and it has fewer children than `max_children`.
- Lowering a limit leaves existing orgs as they are. New creates, revivals and moves are refused until the counts are within the limit. The API logs the counts at boot (`orgTree.bootCheck`): a warning per kind, and an error when the total is over `max_total_orgs`, because that closes self-registration.

## `known_as`

Set in the instance config under `aggregator.organisation.known_as`:

- The system value `aggregator` ("Aggregator") is built in. It is allowed at every depth and cannot be removed or renamed. An org gets it when no other value applies.
- `values`: more values, each `{ key, name, depths? }`. `depths` lists where the value is allowed; without it the value is allowed at any depth.
- `suggest`: a list of `{ depth, key }`. A new self-registered org gets the suggested value for its depth, else `aggregator`.
- Changing an org's `known_as` never moves it. The value must be allowed at the org's depth (`KNOWN_AS_DEPTH`).

## Writes

All tree writes (create, revive of a rejected org, move, `known_as` change) take one transaction-scoped advisory lock (`aggregator-dpg:org-tree`) as their first statement, so the limit counts and the cycle check are exact.

| Route                               | Who                          | What                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/orgs/create`              | Self-registration (service)  | Optional `parent_id` (root when omitted). Refusals: 400 `parent_id` invalid; 409 `ORG_DEPTH_LIMIT`, `ORG_CHILD_LIMIT`, `ORG_TOTAL_LIMIT`. A rejected org registering again is revived under the parent picked now, under the same checks.                                                |
| `GET /v1/orgs/parents`              | Service                      | Parents that can take a child now, and `accepting` (false when registration is closed by the limits).                                                                                                                                                                                    |
| `PATCH /v1/org/metadata/update/:id` | Network admin for `known_as` | Changes `known_as` only; never the parent.                                                                                                                                                                                                                                               |
| `PATCH /v1/org/parent/update/:id`   | Network admin                | Moves a pending or active org (and everything below it) under a new parent, optionally with a new `known_as`. Refusals: `ORG_PARENT_CYCLE`, `ORG_DEPTH_LIMIT`, `ORG_CHILD_LIMIT`, `KNOWN_AS_DEPTH`, 409 `CONFLICT` (not movable, or the row is busy). The moved org's owner is notified. |
| `GET /v1/org/parent/options/:id`    | Network admin                | Every candidate parent with whether the move would succeed and why not.                                                                                                                                                                                                                  |
| `GET /v1/org/hierarchy`             | Network admin                | Limits, total orgs, `known_as` values with their depths and org counts, suggestions.                                                                                                                                                                                                     |

## Reads below an org

An owner reads, view-only, every org and coordinator below the orgs it owns (`services/authz/view-scope.ts`). Writes keep the owned reach. Contacts below are masked, and those reads log `relation: 'below'`. RBAC roles held in an org do not apply below it.

## Upgrading an existing instance

No manual data step is needed. Migration 0032 runs at API boot and is safe while older pods still serve (migrations after the 0023–0029 instance upgrade run at boot; see `migration-guards.ts`).

- **Data.** `known_as` is added with the default `aggregator`, so every existing org is "Aggregator" without a table rewrite. `depth` is filled from the parent chain: every org directly under the root gets 1. The migration is idempotent. `scripts/sql/organisation-verify.sql` gate V9 checks the result.
- **Config.** An instance config without `aggregator.organisation` keeps a flat tree: every org directly under the network, at most 50 orgs, and every org "Aggregator". Add the block only to use levels, more depth or a different total.
- **Instances already over a limit.** Existing orgs are kept, with their coordinators, as they are. The API logs `orgTree.bootCheck` with the counts; a total over `max_total_orgs` is logged as an error (`registration: "closed"`). Self-registration of new orgs is closed (`accepting: false`, `409 ORG_TOTAL_LIMIT`), and so are revivals and moves that break a limit. Approving an org that is already pending is not limited. Coordinator registration into existing orgs is not affected. **Release checklist:** count the instance's pending and active orgs (the Default org excluded) before upgrading; if there are 50 or more, set `max_total_orgs` above that count first, or self-registration closes on the first boot.
- **Rollout order.** Deploy the API before the web app. Older API pods insert orgs without `depth`; the `BEFORE INSERT` trigger fills it. Older web pods work with the new API: the new response fields are additive and `parent_id` on `POST /v1/orgs/create` is optional. The new web app needs `GET /v1/orgs/parents`, so against an older API the org registration form shows an error and a retry button.
- **RBAC edge.** `policy/rbac/edge/routes.json` adds `GET /v1/org/hierarchy`, `GET /v1/org/parent/options/:id`, `PATCH /v1/org/parent/update/:id` and `GET /v1/orgs/parents`. Where the edge policy is enforced, ship the updated policy bundle with the release; until then the edge refuses these routes.
- **Rollback.** The columns, trigger and CHECK stay. Older code ignores the columns, and the trigger fills `depth` on its inserts. Orgs placed under another org keep that parent.
