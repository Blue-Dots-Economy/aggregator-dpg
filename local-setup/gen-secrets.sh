#!/usr/bin/env sh
# Fills every CHANGE_ME_* placeholder in local-setup/.env with a freshly
# generated random value.
#
#   cp .env.example .env
#   ./gen-secrets.sh
#
# Values are written to `.env` only — never back into `.env.example`, which is
# committed. Re-running is safe: already-filled values are left alone, so it
# will not invalidate data encrypted under an existing SIGNALS_PII_KEY.
#
# Everything gets `openssl rand -hex 32` except SIGNALS_PII_KEY, which the
# signals API requires to be base64 decoding to exactly 32 bytes (AES-256).
set -eu

ENV_FILE="${1:-$(dirname "$0")/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "No $ENV_FILE — run: cp .env.example .env" >&2
  exit 1
fi

# Placeholder lines look like `NAME=CHANGE_ME_ANYTHING`.
vars=$(sed -n 's/^\([A-Z0-9_]*\)=CHANGE_ME_.*$/\1/p' "$ENV_FILE")

if [ -z "$vars" ]; then
  echo "$ENV_FILE has no CHANGE_ME_* placeholders left — nothing to do."
  exit 0
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
cp "$ENV_FILE" "$tmp"

for name in $vars; do
  case "$name" in
    SIGNALS_PII_KEY) value=$(openssl rand -base64 32) ;;
    *)               value=$(openssl rand -hex 32) ;;
  esac
  # `value` is hex or base64, so the only character needing care in the sed
  # replacement is base64's `/`; `|` is not in either alphabet, so use it as
  # the delimiter and escape nothing else.
  sed "s|^${name}=CHANGE_ME_.*$|${name}=${value}|" "$tmp" > "$tmp.next"
  mv "$tmp.next" "$tmp"
  echo "  generated $name"
done

cat "$tmp" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Wrote $(echo "$vars" | wc -w | tr -d ' ') secrets into $ENV_FILE (mode 600)."
