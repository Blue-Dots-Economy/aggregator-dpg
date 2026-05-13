#!/bin/sh
# Post-import init for the aggregator realm:
#   1. Enable Unmanaged Attributes (so phone_number, aggregator_id, etc. persist).
#   2. Apply SMTP server config from env vars (KC needs this for email OTP + verify).
#
# KC 26 ignores `kc.user.profile.config` and `smtpServer` from realm import in
# some paths, so we apply both via admin REST API after Keycloak is healthy.
set -eu

KC_URL="${KC_URL:-http://keycloak:8080}"
REALM="${KC_REALM:-aggregator}"
ADMIN_USER="${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}"
ADMIN_PASS="${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin}"
POLICY="${UNMANAGED_POLICY:-ENABLED}"

echo "[kc-init] waiting for keycloak at ${KC_URL}..."
i=0
until curl -fsS "${KC_URL}/realms/master/.well-known/openid-configuration" > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[kc-init] keycloak not reachable after 5min — aborting"
    exit 1
  fi
  sleep 5
done

echo "[kc-init] obtaining admin token..."
TOKEN=$(curl -fsS -X POST "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${ADMIN_USER}" \
  -d "password=${ADMIN_PASS}" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

if [ -z "$TOKEN" ]; then
  echo "[kc-init] failed to obtain admin token"
  exit 1
fi

# ────────────────────────────────────────────────────────────
# 1) Unmanaged Attributes policy
# ────────────────────────────────────────────────────────────
CURRENT_UP=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/users/profile" -H "Authorization: Bearer ${TOKEN}")
if echo "$CURRENT_UP" | grep -q "\"unmanagedAttributePolicy\":\"${POLICY}\""; then
  echo "[kc-init] unmanagedAttributePolicy already ${POLICY} — skip"
else
  UPDATED_UP=$(echo "$CURRENT_UP" | sed 's/^{/{"unmanagedAttributePolicy":"'"${POLICY}"'",/')
  HTTP=$(curl -s -o /tmp/up-resp.json -w "%{http_code}" -X PUT \
    "${KC_URL}/admin/realms/${REALM}/users/profile" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${UPDATED_UP}")
  if [ "$HTTP" != "200" ]; then
    echo "[kc-init] user-profile PUT failed: HTTP ${HTTP}"
    cat /tmp/up-resp.json || true
    exit 1
  fi
  echo "[kc-init] unmanagedAttributePolicy set to ${POLICY}"
fi

# ────────────────────────────────────────────────────────────
# 2) SMTP server config
# ────────────────────────────────────────────────────────────
if [ -z "${SMTP_HOST:-}" ]; then
  echo "[kc-init] SMTP_HOST empty — skipping smtpServer config"
  exit 0
fi

# Derive starttls/ssl from SMTP_SECURE + port. Gmail 587 → starttls. 465 → ssl.
SSL="false"
STARTTLS="false"
case "${SMTP_PORT:-587}" in
  465) SSL="true" ;;
  587) STARTTLS="true" ;;
  *) [ "${SMTP_SECURE:-false}" = "true" ] && SSL="true" ;;
esac
AUTH="false"
[ -n "${SMTP_USER:-}" ] && AUTH="true"

# Build smtpServer JSON. Escape password spaces by JSON-encoding via sh.
SMTP_JSON=$(cat <<EOF
{
  "host": "${SMTP_HOST}",
  "port": "${SMTP_PORT:-587}",
  "from": "${SMTP_FROM:-no-reply@example.com}",
  "fromDisplayName": "${SMTP_FROM_DISPLAY:-Aggregator}",
  "ssl": "${SSL}",
  "starttls": "${STARTTLS}",
  "auth": "${AUTH}",
  "user": "${SMTP_USER:-}",
  "password": "${SMTP_PASSWORD:-}"
}
EOF
)

# Fetch full realm rep, splice in smtpServer, PUT back.
REALM_REP=$(curl -fsS "${KC_URL}/admin/realms/${REALM}" -H "Authorization: Bearer ${TOKEN}")

# Use python (available in curl image? no — curlimages is alpine sh). Use jq if present, else fallback sed.
if command -v jq > /dev/null 2>&1; then
  UPDATED_REALM=$(echo "$REALM_REP" | jq --argjson s "$SMTP_JSON" '.smtpServer = $s')
else
  # crude splice: remove existing smtpServer block then inject after opening brace
  STRIPPED=$(echo "$REALM_REP" | sed -E 's/,?"smtpServer":\{[^}]*\}//')
  UPDATED_REALM=$(echo "$STRIPPED" | sed 's/^{/{"smtpServer":'"$(echo "$SMTP_JSON" | tr -d '\n' | tr -s ' ')"',/')
fi

HTTP=$(curl -s -o /tmp/smtp-resp.json -w "%{http_code}" -X PUT \
  "${KC_URL}/admin/realms/${REALM}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${UPDATED_REALM}")

if [ "$HTTP" != "204" ] && [ "$HTTP" != "200" ]; then
  echo "[kc-init] smtpServer PUT failed: HTTP ${HTTP}"
  cat /tmp/smtp-resp.json || true
  exit 1
fi

echo "[kc-init] smtpServer configured: ${SMTP_HOST}:${SMTP_PORT:-587} (ssl=${SSL} starttls=${STARTTLS} auth=${AUTH})"
