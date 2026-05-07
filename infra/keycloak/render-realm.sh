#!/bin/sh
# Renders realm JSON templates from /opt/keycloak/data/import-template into the
# import dir, substituting __PUBLIC_BASE_URL__ with $PUBLIC_BASE_URL, then hands
# off to the upstream Keycloak entrypoint.
#
# Why a render step: Keycloak --import-realm does not perform env-var
# substitution on realm JSON. Hardcoding public hostnames/IPs in the checked-in
# realm forces a code edit per environment. This script lets the same template
# boot on any VM by reading PUBLIC_BASE_URL at container start.
set -eu

SRC_DIR="/opt/keycloak/data/import-template"
DST_DIR="/opt/keycloak/data/import"

: "${PUBLIC_BASE_URL:?PUBLIC_BASE_URL must be set (e.g. http://1.2.3.4 or https://portal.example.com)}"

mkdir -p "$DST_DIR"

# Escape sed replacement metacharacters (& and |) in the URL.
escaped=$(printf '%s' "$PUBLIC_BASE_URL" | sed -e 's/[&|]/\\&/g')

for src in "$SRC_DIR"/*.json; do
  [ -f "$src" ] || continue
  dst="$DST_DIR/$(basename "$src")"
  sed "s|__PUBLIC_BASE_URL__|${escaped}|g" "$src" > "$dst"
  echo "rendered $(basename "$src") -> $dst (PUBLIC_BASE_URL=$PUBLIC_BASE_URL)"
done

exec /opt/keycloak/bin/kc.sh "$@"
