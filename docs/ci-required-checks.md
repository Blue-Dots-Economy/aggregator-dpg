# CI Required Status Checks

A repo admin must configure branch protection on `main` (and any `v0.*` release branches) to require the following status checks before merging.

## How to configure

GitHub → Repository settings → Branches → Branch protection rules → `main` → **Require status checks to pass before merging**.

Add each check name exactly as listed below (copy-paste — GitHub matches by exact string).

## Required checks

| Check name | What it gates                              |
| ---------- | ------------------------------------------ |
| `CI`       | Lint + typecheck + test + build on Node 24 |

> The check name comes from the `name:` field of the `ci` job in `ci.yml`.
> If the job name ever changes, update this doc and re-pin the checks.

## Advisory checks (not required)

| Check name                 | What it reports                                    |
| -------------------------- | -------------------------------------------------- |
| `SonarCloud Code Analysis` | Coverage + code-quality gate, posted by SonarCloud |

This check is **deliberately not in the required list**. It is posted by SonarCloud
(project `Blue-Dots-Economy_aggregator-dpg`, org `blue-dots-economy`) after the
`SonarCloud scan` step in the `ci` job, and currently fails its gate — so requiring
it would block every merge. Treat it as a signal to act on, not a merge blocker,
until coverage and the security rating are green.

### How it is wired

- Analysis is **CI-based**; SonarCloud's own "Automatic Analysis" is switched off
  (both cannot run against one project).
- `sonar-project.properties` at the repo root holds the project/org keys, source and
  test inclusions, and one `lcov.info` path per app/package.
- The `Generate coverage reports (for SonarCloud)` step runs `pnpm -w test:coverage`
  and is `continue-on-error: true` **on purpose**: a few packages sit below their own
  local vitest thresholds, and that must not fail the build. The separate `Test` step
  is what actually gates. Do not "tidy" these into one step — that re-introduces the
  coupling.
- `SONAR_TOKEN` lives in repo Actions secrets. Checkout uses `fetch-depth: 0` so
  Sonar can attribute new code to the right commits.

### The 80%-vs-70% gap

The repo's documented standard is **≥70% line coverage** (`.claude/rules/testing-requirements.md`),
but the gate in force is SonarCloud's built-in `Sonar way`, which requires **≥80% coverage
on new code**. These cannot currently be reconciled: the organisation is on the **free plan**,
which allows _creating_ a custom quality gate but not _associating_ one with a project
("Your current plan does not allow you to associate a quality gate other than Sonar way").
Closing the gap needs a plan upgrade. Note the project has _Ignore duplication and coverage
on small changes_ enabled, so coverage conditions are skipped until a change adds ≥20 new lines.

## Recommended additional settings

- **Require branches to be up to date before merging** — prevents stale-branch merges.
- **Do not allow bypassing the above settings** — prevents admins from merging broken PRs.
- **Restrict who can push to matching branches** — limit to release managers only.
