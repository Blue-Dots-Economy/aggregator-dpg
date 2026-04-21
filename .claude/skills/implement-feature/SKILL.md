---
name: implement-feature
description: Use when user provides a GitHub feature issue number and feature ID (e.g. F-01.1) from the aggregator-dpg backlog to implement
---

# Feature Implementation Workflow

## Overview

Read spec → create task sub-issues → ask questions → implement → commit per task → PR at end.
Never write code before questions are answered. Never create PR before all tasks are committed.

## Step 1 — Read (parallel)

```bash
gh issue view <issue-number>   # feature issue: body, labels, milestone
```

Also read the feature section in the doc:
- Platform features: `docs/issues/platform/P-NN-features.md` → find `## F-NN.N`
- Product features: `docs/issues/product/PH-N-features.md` → find `## F-...`

Extract: Story, AC items, Tests, and every `T-XX.X.X` task line.

## Step 2 — Create sub-issues per task

Get current GitHub user first:
```bash
GH_USER=$(gh api user --jq .login)
```

For each `T-XX.X.X` task:

```bash
# Create sub-issue
NEW=$(gh issue create \
  --title "T-XX.X.X <task description verbatim>" \
  --body "**Parent feature:** #<feature-issue-number> F-XX.X <feature title>

**Task:** T-XX.X.X <description>

Part of: <Story line from feature doc>" \
  --assignee "$GH_USER" \
  --label "<comma-separated labels copied from parent issue>")

# Link as sub-issue of the parent feature issue
PARENT_NODE=$(gh issue view <feature-issue-number> --json id -q .id)
NEW_NODE=$(gh issue view "$NEW" --json id -q .id)
gh api graphql -f query="mutation { addSubIssue(input: { issueId: \"$PARENT_NODE\", subIssueId: \"$NEW_NODE\" }) { issue { id } } }"
```

Record each `T-XX.X.X → #NNN` mapping — needed for commits.

## Step 3 — Ask questions before coding

In ONE message, surface:
- Ambiguous AC items
- Dependencies on packages not yet scaffolded
- Unresolved open questions from the epic doc (`P-NN-*.md`, same number, no `-features` suffix)
- Any config key or threshold that needs confirming

**Wait for all answers before proceeding.**

## Step 4 — Create branch

```bash
git checkout -b feat/F-XX.X-<short-slug>
# e.g. feat/F-01.1-pnpm-workspaces
```

Slug = lowercase-hyphenated from the feature title.

## Step 5 — Implement task by task

For each task in order:
1. Implement
2. Stage relevant files only (no `git add .`)
3. Commit:

```
#<sub-issue-number> feat(T-XX.X.X): <imperative description>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Examples:
```
#312 feat(T-01.1.1): init pnpm and pnpm-workspace.yaml
#313 feat(T-01.1.2): install turbo and define base pipeline
```

Rules:
- One task = one or more commits, all referencing the **same** sub-issue `#NNN`
- Never mix two T-references in one commit
- Use `fix`/`chore`/`test`/`docs` instead of `feat` when more accurate

## Step 6 — Create PR (only after ALL tasks done)

```bash
gh pr create \
  --title "feat(F-XX.X): <feature title>" \
  --body "$(cat <<'EOF'
## Summary
<Story from feature doc>

## AC
- [ ] <copy AC items from feature doc; tick completed ones>

## Sub-issues resolved
- #NNN T-XX.X.X <description>
- #NNN T-XX.X.X <description>

Closes #<feature-issue-number>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## Quick reference

| Thing | Convention |
|-------|-----------|
| Branch | `feat/F-XX.X-<slug>` |
| Commit prefix | `#<sub-issue> feat(T-XX.X.X):` |
| Assignee | `$(gh api user --jq .login)` — current GH user |
| PR timing | After **all** tasks committed |
| Feature doc path (platform) | `docs/issues/platform/P-NN-features.md` |
| Feature doc path (product) | `docs/issues/product/PH-N-features.md` |
| Epic context | `docs/issues/platform/P-NN-<name>.md` (same NN, no `-features`) |

## Common mistakes

- Creating PR before all tasks committed → wait
- Mixing T-references in one commit → one task per commit
- Skipping questions → unresolved deps waste implementation time
- Using `git add .` → stage specific files only
