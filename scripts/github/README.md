# GitHub setup scripts

Idempotent scripts to set up the Aggregator DPG backlog on GitHub.

## Prereqs

- `gh` CLI authenticated. For Projects v2 you need the `project` scope:

  ```bash
  gh auth refresh -s project
  ```

- Node ≥ 18 (for the `.mjs` scripts).

## Order of operations

```bash
# Stage A: labels + milestones (needs `repo` scope only)
./scripts/github/setup-labels.sh
./scripts/github/setup-milestones.sh

# Stage B: Projects v2 board + fields (needs `project` scope)
node scripts/github/setup-project.mjs

# Stage C: issues (epics first, then features + stubs)
# Dry-run first to verify parsing:
node scripts/github/push-issues.mjs --dry-run --limit 5
# For real:
node scripts/github/push-issues.mjs
```

`push-issues.mjs` caches state in `scripts/github/.issue-map.json`. Re-running skips already-created issues. Delete the file to force re-creation.

## What gets created

- **Epics:** one GitHub issue per file under `docs/issues/**` that is not `*-features.md` / `*-stubs.md` / `INDEX.md` / `README.md`.
- **Features:** one issue per `## ` H2 section inside each `*-features.md` file.
- **Stubs:** one issue per H2 section inside `post-mvp/X-01-stubs.md`.
- **Sub-issues:** each feature is linked as a sub-issue of its parent epic via the GraphQL `addSubIssue` mutation.
- **Project membership:** every issue added to the "Aggregator DPG — MVP" project board.

Inline task checklists inside feature bodies are preserved as GitHub task lists (per your preference — not split into separate task issues).
