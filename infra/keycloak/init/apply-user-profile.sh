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
# 1b) org hierarchy: org_owner realm role + service-account grant
#
# realm.json is only consulted on first import, so these are re-applied
# idempotently here for realms that already exist in postgres. Both are
# required before ORG_HIERARCHY_ENABLED=true, and harmless when it is off:
#   - org_owner realm role: assigned to the org-owner user at org approval.
#   - aggregator-api service account needs realm-management:manage-realm
#     (in addition to manage-users) to create/manage the org's KC group.
# Placed before the SMTP early-exit below so they always run.
# ────────────────────────────────────────────────────────────
API_CLIENT_ID="${API_CLIENT_ID:-aggregator-api}"

# --- 1b-i. ensure org_owner realm role exists ---
ROLE_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  "${KC_URL}/admin/realms/${REALM}/roles/org_owner" -H "Authorization: Bearer ${TOKEN}")
if [ "$ROLE_HTTP" = "200" ]; then
  echo "[kc-init] realm role 'org_owner' already present — skip"
else
  HTTP=$(curl -s -o /tmp/role-resp.json -w "%{http_code}" -X POST \
    "${KC_URL}/admin/realms/${REALM}/roles" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"name":"org_owner","description":"Parent-org owner (org hierarchy). Assigned to the org-owner user at org approval."}')
  if [ "$HTTP" = "201" ]; then
    echo "[kc-init] realm role 'org_owner' created"
  else
    echo "[kc-init] realm role 'org_owner' create FAILED: HTTP ${HTTP}"
    cat /tmp/role-resp.json || true
  fi
fi

# --- 1b-ii. grant realm-management:manage-realm to the API service account ---
API_UUID=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients?clientId=${API_CLIENT_ID}" \
  -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id // empty')
RM_UUID=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients?clientId=realm-management" \
  -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id // empty')
if [ -z "$API_UUID" ] || [ -z "$RM_UUID" ]; then
  echo "[kc-init] '${API_CLIENT_ID}' or realm-management client not found — skip manage-realm grant"
else
  SA_UID=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients/${API_UUID}/service-account-user" \
    -H "Authorization: Bearer ${TOKEN}" | jq -r '.id // empty')
  HAS_MR=$(curl -fsS \
    "${KC_URL}/admin/realms/${REALM}/users/${SA_UID}/role-mappings/clients/${RM_UUID}" \
    -H "Authorization: Bearer ${TOKEN}" | jq -r '[.[] | select(.name == "manage-realm")] | length')
  if [ -z "$SA_UID" ]; then
    echo "[kc-init] service-account user for '${API_CLIENT_ID}' not found — skip manage-realm grant"
  elif [ "${HAS_MR:-0}" -gt 0 ]; then
    echo "[kc-init] service account already has realm-management:manage-realm — skip"
  else
    MR_ROLE=$(curl -fsS \
      "${KC_URL}/admin/realms/${REALM}/clients/${RM_UUID}/roles/manage-realm" \
      -H "Authorization: Bearer ${TOKEN}")
    HTTP=$(curl -s -o /tmp/mr-resp.json -w "%{http_code}" -X POST \
      "${KC_URL}/admin/realms/${REALM}/users/${SA_UID}/role-mappings/clients/${RM_UUID}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      --data "[${MR_ROLE}]")
    if [ "$HTTP" = "204" ] || [ "$HTTP" = "200" ]; then
      echo "[kc-init] granted realm-management:manage-realm to '${API_CLIENT_ID}' service account"
    else
      echo "[kc-init] manage-realm grant FAILED: HTTP ${HTTP}"
      cat /tmp/mr-resp.json || true
    fi
  fi
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

# ────────────────────────────────────────────────────────────
# 3) aggregator-portal client: enforce confidential + mappers
#
# realm.json is only consulted on first realm import. When the realm
# already exists in postgres (e.g. an upgrade from a pre-merge stack),
# any changes to client config or protocolMappers in realm.json are NOT
# applied automatically. This block re-applies them idempotently on
# every boot:
#   - publicClient=false + clientAuthenticatorType=client-secret
#   - client secret = $OIDC_CLIENT_SECRET (must match the BFF env var)
#   - protocol mappers for decision_made + phone_number (required by
#     requireApproved middleware on the API)
# ────────────────────────────────────────────────────────────

PORTAL_CLIENT_ID="${PORTAL_CLIENT_ID:-aggregator-portal}"

# Use jq — the alpine entrypoint installs it. A greedy sed match here would
# pick up the LAST `id` field in the JSON (a protocolMapper UUID), not the
# client UUID, and the next call would 404.
PORTAL_UUID=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients?clientId=${PORTAL_CLIENT_ID}" \
  -H "Authorization: Bearer ${TOKEN}" | jq -r '.[0].id // empty')

if [ -z "$PORTAL_UUID" ]; then
  echo "[kc-init] portal client '${PORTAL_CLIENT_ID}' not found — skip client/mapper reconcile"
else
  # --- 3a. publicClient + secret ----------------------------------------
  if [ -n "${OIDC_CLIENT_SECRET:-}" ]; then
    PORTAL_REP=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients/${PORTAL_UUID}" \
      -H "Authorization: Bearer ${TOKEN}")
    if command -v jq > /dev/null 2>&1; then
      UPDATED_PORTAL=$(echo "$PORTAL_REP" | jq --arg s "$OIDC_CLIENT_SECRET" \
        '.publicClient = false | .clientAuthenticatorType = "client-secret" | .secret = $s')
    else
      # fallback: jq is installed by the keycloak-init entrypoint, so this
      # branch is defensive — we just leave the client config alone.
      UPDATED_PORTAL=""
    fi
    if [ -n "$UPDATED_PORTAL" ]; then
      HTTP=$(curl -s -o /tmp/portal-resp.json -w "%{http_code}" -X PUT \
        "${KC_URL}/admin/realms/${REALM}/clients/${PORTAL_UUID}" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/json" \
        --data "${UPDATED_PORTAL}")
      if [ "$HTTP" = "204" ] || [ "$HTTP" = "200" ]; then
        echo "[kc-init] portal client: publicClient=false, secret synced from OIDC_CLIENT_SECRET"
      else
        echo "[kc-init] portal client update FAILED: HTTP ${HTTP}"
        cat /tmp/portal-resp.json || true
      fi
    fi
  else
    echo "[kc-init] OIDC_CLIENT_SECRET empty — leaving portal client publicClient/secret untouched"
  fi

  # --- 3b. protocol mappers --------------------------------------------
  ensure_mapper() {
    mapper_name="$1"
    user_attr="$2"
    claim_name="$3"
    userinfo_claim="$4"
    existing=$(curl -fsS "${KC_URL}/admin/realms/${REALM}/clients/${PORTAL_UUID}/protocol-mappers/models" \
      -H "Authorization: Bearer ${TOKEN}" \
      | jq -r --arg n "${mapper_name}" '[.[] | select(.name == $n)] | length')
    if [ "$existing" -gt 0 ]; then
      echo "[kc-init] mapper '${mapper_name}' already present — skip"
      return 0
    fi
    PAYLOAD=$(cat <<EOF
{
  "name": "${mapper_name}",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-usermodel-attribute-mapper",
  "consentRequired": false,
  "config": {
    "user.attribute": "${user_attr}",
    "claim.name": "${claim_name}",
    "jsonType.label": "String",
    "id.token.claim": "false",
    "access.token.claim": "true",
    "userinfo.token.claim": "${userinfo_claim}",
    "multivalued": "false",
    "aggregate.attrs": "false"
  }
}
EOF
)
    HTTP=$(curl -s -o /tmp/mapper-resp.json -w "%{http_code}" \
      -X POST "${KC_URL}/admin/realms/${REALM}/clients/${PORTAL_UUID}/protocol-mappers/models" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      --data "${PAYLOAD}")
    if [ "$HTTP" = "201" ]; then
      echo "[kc-init] mapper '${mapper_name}' created"
    else
      echo "[kc-init] mapper '${mapper_name}' create FAILED: HTTP ${HTTP}"
      cat /tmp/mapper-resp.json || true
    fi
  }

  ensure_mapper "decision_made" "decision_made" "decision_made" "false"
  ensure_mapper "phone_number"  "phoneNumber"   "phone_number"  "true"
fi
