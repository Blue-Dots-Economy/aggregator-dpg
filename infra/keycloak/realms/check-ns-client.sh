#!/usr/bin/env bash
# Asserts the notification-service resource-server client, its roles, and the
# signals-api grant are present in the local realm.
set -euo pipefail
R="${1:-$(dirname "$0")/realm.json}"
jq -e '.clients[] | select(.clientId=="notification-service") | .bearerOnly == true and .standardFlowEnabled == false and .serviceAccountsEnabled == false and .directAccessGrantsEnabled == false and (has("secret") | not)' "$R" >/dev/null
jq -e '[.roles.client["notification-service"][].name] | sort == ["notify:send","templates:admin"]' "$R" >/dev/null
jq -e '.users[] | select(.username=="service-account-signals-api") | .clientRoles["notification-service"] == ["notify:send"]' "$R" >/dev/null
echo "notification-service client: ok"
