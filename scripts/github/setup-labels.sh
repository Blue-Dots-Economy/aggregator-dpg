#!/usr/bin/env bash
# Create / update GitHub labels for the Aggregator DPG repo. Idempotent.
# Usage: ./scripts/github/setup-labels.sh [<owner/repo>]
# Default repo: sanketika-labs/aggregator-dpg

set -euo pipefail

REPO="${1:-sanketika-labs/aggregator-dpg}"

# color, name, description
declare -a LABELS=(
  # type
  "6f42c1|type:epic|Large body of work spanning multiple features"
  "0e8a16|type:feature|Deliverable feature under an epic"
  "c5def5|type:task|Concrete implementation unit"
  "d73a4a|type:bug|Unexpected behaviour"
  "fef2c0|type:spike|Timeboxed investigation"

  # area
  "1d76db|area:backend|API / service code"
  "5319e7|area:frontend|Web app (apps/web)"
  "0052cc|area:db|Database / persistence"
  "b60205|area:auth|Auth / sessions / OTP"
  "0075ca|area:observability|Logs / metrics / traces / audit"
  "a2eeef|area:config|Configuration surface"
  "d4c5f9|area:security|Security baseline + controls"
  "bfd4f2|area:qa|Testing infrastructure"
  "fbca04|area:devex|Dev experience / CI"
  "c2e0c6|area:sps|Signal Processing Service"

  # phase
  "ededed|phase:0|Foundations"
  "e1bee7|phase:1|Registration & Profile"
  "c5cae9|phase:2|Onboarding"
  "b2dfdb|phase:3|My Blue Dots"
  "ffccbc|phase:4|Hardening"
  "d1d5da|phase:post-mvp|Deferred beyond MVP"

  # JTBD
  "ffd966|jtbd:AG-0|Registration + login"
  "ffd966|jtbd:AG-0a|Registration status tracking"
  "ffd966|jtbd:AG-0b|Participant dashboard"
  "ffd966|jtbd:AG-0c|Profile view/edit"
  "ffd966|jtbd:AG-1|Onboarding entry point"
  "ffd966|jtbd:AG-1a|Per-mode conversion"
  "ffd966|jtbd:AG-1b|Flagged profiles"
  "ffd966|jtbd:AG-1c|Bulk onboarding"
  "ffd966|jtbd:AG-2|Connection activity + follow-up"
  "ffd966|jtbd:AG-3|In-app connection notifications"
  "ffd966|jtbd:AG-4|Direct outreach"
  "ffd966|jtbd:AG-5|Aggregator-of-Aggregators"
  "ffd966|jtbd:AG-6|Aggregated summary sharing"
  "ffd966|jtbd:AG-7|Natural-language queries"
  "ffd966|jtbd:AG-8|Ad-hoc report generation"

  # priority
  "b60205|priority:p0|Critical — blocks MVP"
  "d93f0b|priority:p1|Important — required for MVP"
  "fbca04|priority:p2|Nice-to-have / post-MVP"

  # flags
  "cccccc|needs:decision|Blocked by a product/ops decision"
  "cccccc|needs:upstream-confirmation|Blocked by external team confirmation"
  "e99695|blocked|Currently blocked"
)

echo "Creating/updating labels on $REPO …"
for entry in "${LABELS[@]}"; do
  IFS='|' read -r color name desc <<<"$entry"
  if gh label list --repo "$REPO" --limit 500 --json name --jq '.[].name' | grep -Fxq "$name"; then
    gh label edit "$name" --repo "$REPO" --color "$color" --description "$desc" >/dev/null
    printf "  updated: %s\n" "$name"
  else
    gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" >/dev/null
    printf "  created: %s\n" "$name"
  fi
done

echo "Done."
