# CI Required Status Checks

A repo admin must configure branch protection on `main` (and any `v0.*` release branches) to require the following status checks before merging.

## How to configure

GitHub → Repository settings → Branches → Branch protection rules → `main` → **Require status checks to pass before merging**.

Add each check name exactly as listed below (copy-paste — GitHub matches by exact string).

## Required checks

| Check name | What it gates                              |
| ---------- | ------------------------------------------ |
| `CI`       | Lint + typecheck + test + build on Node 22 |

> The check name comes from the `name:` field of the `ci` job in `ci.yml`.
> If the job name ever changes, update this doc and re-pin the checks.

## Recommended additional settings

- **Require branches to be up to date before merging** — prevents stale-branch merges.
- **Do not allow bypassing the above settings** — prevents admins from merging broken PRs.
- **Restrict who can push to matching branches** — limit to release managers only.
