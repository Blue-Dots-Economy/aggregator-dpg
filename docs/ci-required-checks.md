# CI Required Status Checks

A repo admin must configure branch protection on `main` (and any `v0.*` release branches) to require the following status checks before merging.

## How to configure

GitHub → Repository settings → Branches → Branch protection rules → `main` → **Require status checks to pass before merging**.

Add each check name exactly as listed below (copy-paste — GitHub matches by exact string).

## Required checks

These map to the job matrix in `.github/workflows/ci.yml`:

| Check name     | What it gates                              |
| -------------- | ------------------------------------------ |
| `CI / Node 20` | Lint + typecheck + test + build on Node 20 |
| `CI / Node 22` | Lint + typecheck + test + build on Node 22 |

> The check names come from the `name:` field of the job in `ci.yml`:
> `CI / Node ${{ matrix.node }}` → resolves to `CI / Node 20` and `CI / Node 22`.
> If the job name ever changes, update this doc and re-pin the checks.

## Recommended additional settings

- **Require branches to be up to date before merging** — prevents stale-branch merges.
- **Do not allow bypassing the above settings** — prevents admins from merging broken PRs.
- **Restrict who can push to matching branches** — limit to release managers only.
