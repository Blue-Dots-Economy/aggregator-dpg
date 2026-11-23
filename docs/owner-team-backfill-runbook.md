# Runbook: add existing organisation owners to their own team

**Applies to:** an instance whose organisation owners should onboard participants themselves without pressing "Add myself to My Team" (UP first).
**Tool:** `apps/api/src/tools/owner-team-backfill.ts`, run from the API image as `node dist/tools/owner-team-backfill.js`.

## What it does

For each active organisation, oldest first, it gives the owner a team (coordinator) account in that organisation and approves it. This is the same account "Add myself to My Team" creates:

- on the owner's own contact and login; the owner's Keycloak user is not changed;
- named after the organisation;
- serving the network domains the organisation chose at registration, or every domain if it chose none.

Once the account is active, the owner sees "Onboard participants" in the console.

Rules:

- **One team account per person.** An owner of several organisations gets the account in the oldest one. The others are reported as `team_account_in_other_org`.
- **Consent.** The account's consent row is copied from the owner's newest organisation consent row: the same Terms and Privacy versions and the same valid-till date. Its source is `owner-team-backfill`, so the ledger shows the row was derived, not given on a form. This is only done where the organisation and team member documents at those versions are word for word the same; otherwise the owner is skipped as `documents_differ`. Today that holds for `blue_dot/up-gzb` and `blue_dot/ka-dhwd`, and not for the default content.
- **Skipped, never changed:**
  - the Default organisation;
  - owners who already have an active team account;
  - owners with no recorded login or no phone;
  - owners with no organisation consent row, or an expired one.
- **A pending team account in the same organisation is approved** rather than created again.
- **Safe to re-run.** A second run creates nothing new and resumes after a failure.

## Before you start

- The release with the `auto` setting (`OWNER_SELF_ADD_MODE`, #1165) and this tool is deployed.
- The API's environment as the API pods have it: database, Signals (`SIGNALSTACK_*`), `AGGREGATOR_NETWORK` and `AGGREGATOR_BRAND`. Run it inside an API pod, so it reads the same config.
- Product has agreed that this instance's owners should be on their own team. Each owner adds one to the Team Members and organisation totals.

## Run

```bash
kubectl exec -it deploy/<api deployment> -- node dist/tools/owner-team-backfill.js --dry-run
kubectl exec -it deploy/<api deployment> -- node dist/tools/owner-team-backfill.js
```

The run prints one summary line, then one line per organisation, with org ids and error codes only. It never prints names, emails or phones:

```
owner-team-backfill {"orgs":12,"created":9,"approved":1,"skipped":{"has_team_account":1,"team_account_in_other_org":1,...},"failed":0} (dry run)
  would create: org <id>
  skipped (has_team_account): org <id>
```

| Line                   | Meaning                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `created` / `approved` | A team account was created and approved, or a pending one approved (would be, on a dry run). |
| `skipped (<reason>)`   | Nothing written; see the rules above.                                                        |
| `failed (<code>)`      | A write failed, most often Signals being unavailable (`UNAVAILABLE`). Re-run.                |

The exit code is 1 when any organisation failed.

## After the run

- **Permissions take effect on the next token refresh.** The tool does not run the API's token-roles sync. The API's own reconcile writes the team account's roles into the owner's token at its next pass (`RBAC_TOKEN_ROLES_RECONCILE_MS`, and at every API start). Restart the API pods to apply it at once. Until then, "Onboard participants" may answer "not ready".
- Check with the read-only query in `apps/api/CLAUDE.md` (people who hold both account types), or in the console: each owner's row is tagged "You" in My Team.
- When new Terms are published (a new version), owners accept them like every other user. This tool does not change that.
