#!/usr/bin/env bash
# Fetches the published aggregator form bundle into the local config tree.
#
# Since #640 this repo ships no form schemas: they live in bluedots-schemas and
# a deployment gets them from the initContainer that mounts that tree over
# /app/config. Local dev has no initContainer, so this script performs the same
# motion by hand — without it the registration and profile pages have no form
# and the API answers 503 SCHEMA_UNAVAILABLE.
#
# The file it writes is gitignored on purpose. A committed copy is exactly the
# second source of truth #640 removed.
#
# Usage:  pnpm forms:sync [ref]        (ref defaults to main)
set -euo pipefail

REF="${1:-main}"
REPO="https://raw.githubusercontent.com/Blue-Dots-Economy/bluedots-schemas"
NETWORK="${AGGREGATOR_NETWORK:-blue_dot}"
BRAND="${AGGREGATOR_BRAND:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/config"

# Most specific first, mirroring the resolver's own precedence.
scopes=()
[[ -n "$BRAND" ]] && scopes+=("$NETWORK/$BRAND")
scopes+=("$NETWORK" "")

for scope in "${scopes[@]}"; do
  url="$REPO/refs/heads/$REF/${scope:+$scope/}schemas/aggregator/aggregator-forms.json"
  dest="$ROOT/${scope:+$scope/}schemas/aggregator/aggregator-forms.json"
  if curl -fsS "$url" -o /tmp/aggregator-forms.$$ 2>/dev/null; then
    mkdir -p "$(dirname "$dest")"
    mv /tmp/aggregator-forms.$$ "$dest"
    echo "✔ ${scope:-<shared default>} → ${dest#"$ROOT"/}"
  else
    echo "· ${scope:-<shared default>} — not published at $REF, skipped"
  fi
done

echo
echo "Done. These files are gitignored — re-run after a schemas change."
