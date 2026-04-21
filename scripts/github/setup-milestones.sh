#!/usr/bin/env bash
# Create milestones for the Aggregator DPG repo. Idempotent.
# Usage: ./scripts/github/setup-milestones.sh [<owner/repo>]

set -euo pipefail
REPO="${1:-sanketika-labs/aggregator-dpg}"

declare -a MILESTONES=(
  "Phase 0 — Foundations|Build system, service interfaces, config, data, auth, observability"
  "Phase 1 — Registration & Profile|AG-0 registration + login, AG-0c profile view/edit"
  "Phase 2 — Onboarding|AG-1 / AG-1a / AG-1b / AG-1c: links, QR, bulk, flagged"
  "Phase 3 — My Blue Dots|AG-0b summary + AG-2 participant list + AG-6 export"
  "Phase 4 — Hardening|Perf, DPDP final, a11y, beta rollout, runbook"
  "Post-MVP Backlog|Deferred JTBDs and Future Scope items"
)

existing=$(gh api "/repos/$REPO/milestones?state=all&per_page=100" --jq '.[].title')

echo "Creating/updating milestones on $REPO …"
for entry in "${MILESTONES[@]}"; do
  IFS='|' read -r title desc <<<"$entry"
  if printf '%s\n' "$existing" | grep -Fxq "$title"; then
    printf "  exists:  %s\n" "$title"
  else
    gh api -X POST "/repos/$REPO/milestones" \
      -f title="$title" \
      -f description="$desc" >/dev/null
    printf "  created: %s\n" "$title"
  fi
done

echo "Done."
