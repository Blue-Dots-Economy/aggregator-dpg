# Runbook: coordinator profile types on an existing instance

**Applies to:** every deployed instance moving to the first release where a coordinator can serve several profile types.
**Tool:** `apps/api/scripts/sync-coordinator-profile-types.ts`, run from a checkout of the release (the API image has no `tsx`). Logic in `apps/api/src/services/profile-types-sync.ts`.

## What changes

A coordinator's profile types are stored in `users.serves`. The API checks every coordinator request against the multivalued `aggregator_type` token claim, which Keycloak builds from the user attribute of the same name. Before this release the console wrote the database and Signals only, and Keycloak held the single type set at sign-up.

After this release:

- An empty `serves` (`'{}'`) means the coordinator serves nothing. Migration `0029` stored `'{}'` for coordinators whose old type was NULL, blank or `both`. Those coordinators see "You don't have access yet" until an org owner sets their types in the console.
- Ids in `serves` that the network no longer has are ignored. A coordinator with only such ids also serves nothing.
- Approving a coordinator that serves nothing is refused.

The sync makes each coordinator's Keycloak `aggregator_type` match `users.serves`: the served network domains in network order, or no attribute when it serves none. It does not write the database or Signals. A Signals org that still lists old domains gives no access, because requests are checked against the token claim. The next console edit brings Signals in line.

## Before you start

- **The deployment realm is multivalued.** The bluedots-automation change that makes `aggregator_type` multivalued is deployed. Check the live realm, not the file:
  - `GET /admin/realms/<realm>/users/profile`: `aggregator_type` has `multivalued: true`.
  - `GET /admin/realms/<realm>/clients/<aggregator-portal uuid>/protocol-mappers/models`: the `aggregator_type` mapper has `config.multivalued` `"true"`.
- **Environment:** `DATABASE_URL`, `AGGREGATOR_NETWORK` (and `AGGREGATOR_BRAND` if set), `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_ADMIN_CLIENT_ID`, `KEYCLOAK_ADMIN_CLIENT_SECRET`, as the API uses them. The database role needs read access to `users` only.

```bash
pnpm --filter @aggregator-dpg/api exec tsx scripts/sync-coordinator-profile-types.ts            # dry run
pnpm --filter @aggregator-dpg/api exec tsx scripts/sync-coordinator-profile-types.ts --apply    # write
```

The run prints one log line with counts and coordinator ids, never names, emails or phones:

| Field                       | Meaning                                                         |
| --------------------------- | --------------------------------------------------------------- |
| `coordinators`              | Coordinators read, any status.                                  |
| `inStep`                    | Keycloak already matches.                                       |
| `set`                       | Keycloak set to the served types (would be, on a dry run).      |
| `cleared`                   | Keycloak attribute removed (would be, on a dry run).            |
| `emptyByStatus`, `emptyIds` | Coordinators that serve nothing.                                |
| `unknownOnlyIds`            | Coordinators whose stored ids are all unknown to the network.   |
| `kcMissingIds`              | Coordinators with no Keycloak user. Skipped.                    |
| `failedIds`                 | Keycloak read or write failed after one retry. The run exits 1. |

It does not end sessions. A coordinator's next token refresh carries the new claim.

## Steps, per environment

1. **Realm.** Deploy the bluedots-automation realm change and run the live checks above.
2. **Dry run.** Record the counts in the release notes. Send the `emptyIds` and `unknownOnlyIds` to the org owners and the network admin, so they can set those coordinators' types after the release.
3. **Sync and deploy, back to back.**
   - Freeze console edits to coordinator types. The old console does not write Keycloak, so an edit in this window would undo the sync.
   - Run `--apply`. If it exits 1, run it again; it only changes what is still out of step.
   - Deploy the API and the web together, straight after. Once synced, a coordinator with several types holds several Keycloak values, and the old API reads only the first one.
4. **Re-check.** Run the dry run again. `set` and `cleared` must be 0; if not, run `--apply` again. Then lift the freeze.
5. **Smoke test.**
   - A coordinator that serves nothing sees "You don't have access yet" on the dashboard, onboarding, links and bulk upload.
   - A coordinator that served `provider` still works on providers.
   - A coordinator with two types works on both.
   - Set types for a coordinator that served nothing in the console, sign in again as it, and confirm access.

## Rollback

The database is not changed, so there is no data rollback. On the old API, a coordinator with several Keycloak values is limited to the first one until the new release is deployed again. Coordinators that serve nothing get the old API's access back, except bulk upload and links.
