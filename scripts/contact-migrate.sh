#!/usr/bin/env bash
# Pre-deploy runner for migration 0025 (`contact` table) on an EXISTING instance.
#
# The migration file IS the script: this wrapper runs
# apps/api/drizzle/migrations/0025_contact.sql with psql, exactly as drizzle
# will re-run it at the next API boot (idempotent — a no-op the second time).
# A fresh instance does not need this; its first boot creates everything.
#
# Run it from a checkout of the RELEASE TAG you are about to deploy, so the SQL
# you pre-apply is byte-identical to what the pods will run.
#
# Usage:
#   ./scripts/contact-migrate.sh preflight   # read-only report; blocking checks must be 0
#   ./scripts/contact-migrate.sh dry-run     # apply + verify inside a transaction, then ROLLBACK
#   ./scripts/contact-migrate.sh apply       # apply for real (single transaction)
#   ./scripts/contact-migrate.sh verify      # read-only V1–V6 checks (V4/V6 only while legacy columns exist)
#
# Runbook: preflight → (fix rows) → dry-run → apply (off-peak) → verify →
#          deploy → verify again. See docs/plans/contact-table-phase-1.md §6.3.
#
# Postgres — pick ONE (read from the environment or the project .env):
#   DATABASE_URL   postgres://user:pass@host:port/db   (uses local psql)
#   PG_CONTAINER   docker container name              (uses `docker exec psql`)
#                  with PG_USER / PG_DB (default POSTGRES_USER / POSTGRES_DB)
#   PSQL_CMD       full command prefix, e.g. "kubectl exec -i pod/psql -- psql -U app -d aggregator"
#
# Run it as the application role that owns the tables, or as a role that may
# SET ROLE to it (e.g. a superuser): 0025 switches to the table owner itself so
# everything it creates stays writable by the app, and refuses any other role.
#
# Needs bash + psql (or docker / kubectl) and python3 (only to read .env).
# PSQL_CMD is word-split, so it cannot carry quoted arguments with spaces.
#
# The script never writes drizzle's __drizzle_migrations table; the API boot
# records 0025 there when it re-runs the (now no-op) file.

set -euo pipefail

MODE="${1:-}"
case "$MODE" in
  preflight | dry-run | apply | verify) ;;
  *)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/apps/api/drizzle/migrations/0025_contact.sql"
PREFLIGHT="$ROOT/scripts/sql/contact-preflight.sql"
VERIFY="$ROOT/scripts/sql/contact-verify.sql"

for f in "$MIGRATION" "$PREFLIGHT" "$VERIFY"; do
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }
done

# ─── Load DB settings from .env (only the keys this script reads) ────────────
_KEYS="DATABASE_URL PG_CONTAINER PG_USER PG_DB POSTGRES_USER POSTGRES_DB PSQL_CMD"
for _envfile in "$ROOT/.env" "$PWD/.env"; do
  if [[ -f "$_envfile" ]]; then
    _exports=$(KEYS="$_KEYS" ENVFILE="$_envfile" python3 -c '
import os, re, shlex
keys = set(os.environ["KEYS"].split())
with open(os.environ["ENVFILE"]) as fh:
    for line in fh:
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if not m or m.group(1) not in keys or m.group(1) in os.environ:
            continue
        v = m.group(2)
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("\"", "'"'"'"):
            v = v[1:-1]
        print("export {}={}".format(m.group(1), shlex.quote(v)))
')
    [[ -n "$_exports" ]] && eval "$_exports"
    break
  fi
done

PSQL_FLAGS=(-X -v ON_ERROR_STOP=1)
if [[ -n "${PSQL_CMD:-}" ]]; then
  # shellcheck disable=SC2206
  PSQL=($PSQL_CMD)
elif [[ -n "${DATABASE_URL:-}" ]]; then
  command -v psql >/dev/null || { echo "psql not found on PATH" >&2; exit 1; }
  PSQL=(psql "$DATABASE_URL")
elif [[ -n "${PG_CONTAINER:-}" ]]; then
  PSQL=(docker exec -i "$PG_CONTAINER" psql -U "${PG_USER:-${POSTGRES_USER:-aggregator}}" -d "${PG_DB:-${POSTGRES_DB:-aggregator}}")
else
  echo "set DATABASE_URL, PG_CONTAINER or PSQL_CMD" >&2
  exit 1
fi

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi; }
echo "0025_contact.sql sha256: $(sha "$MIGRATION" | cut -d' ' -f1)"
echo "mode: $MODE"

# Files are streamed on stdin so the same invocation works for local psql,
# `docker exec -i` and `kubectl exec -i` alike.
# 0025 is the EXPAND step. Once 0026 has dropped the legacy columns it must not
# be re-applied (it would try to relax columns that no longer exist).
if [[ "$MODE" == "apply" || "$MODE" == "dry-run" || "$MODE" == "preflight" ]]; then
  legacy=$(echo "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='aggregators' AND column_name='contact';" \
    | "${PSQL[@]}" "${PSQL_FLAGS[@]}" -At)
  if [[ "$legacy" == "0" ]]; then
    echo "the legacy contact columns are already dropped (migration 0026) — nothing to pre-apply; use: $0 verify" >&2
    exit 1
  fi
fi

case "$MODE" in
  preflight)
    "${PSQL[@]}" "${PSQL_FLAGS[@]}" < "$PREFLIGHT"
    ;;
  verify)
    if [[ "$(echo "SELECT to_regclass('public.contact') IS NOT NULL;" | "${PSQL[@]}" "${PSQL_FLAGS[@]}" -At)" != "t" ]]; then
      echo "table \"contact\" does not exist yet — run: $0 apply" >&2
      exit 1
    fi
    "${PSQL[@]}" "${PSQL_FLAGS[@]}" < "$VERIFY"
    legacy=$(echo "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='aggregators' AND column_name='contact';" \
      | "${PSQL[@]}" "${PSQL_FLAGS[@]}" -At)
    if [[ "$legacy" != "0" ]]; then
      "${PSQL[@]}" "${PSQL_FLAGS[@]}" < "$ROOT/scripts/sql/contact-verify-legacy.sql"
    fi
    ;;
  dry-run)
    { echo 'BEGIN;'; cat "$MIGRATION"; echo; cat "$VERIFY"; echo; cat "$ROOT/scripts/sql/contact-verify-legacy.sql"; echo; echo 'ROLLBACK;'; } \
      | "${PSQL[@]}" "${PSQL_FLAGS[@]}"
    echo "dry-run complete — rolled back, nothing changed"
    ;;
  apply)
    "${PSQL[@]}" "${PSQL_FLAGS[@]}" --single-transaction < "$MIGRATION"
    echo "applied — now run: $0 verify"
    ;;
esac
