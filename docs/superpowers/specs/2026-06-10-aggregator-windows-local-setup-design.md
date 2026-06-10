# Cross-platform local setup (Windows native support) — Design

**Date:** 2026-06-10
**Status:** Approved (pending written-spec review)
**Branch:** `feat/windows-local-setup` (off `feature`)

## Problem

The aggregator-dpg local stack is driven by a `Makefile` whose recipes assume a
POSIX shell and Unix host conventions: `make` itself, sh conditionals
(`if [ -f .env ]`), `grep`/`cp`/`chmod 600`, `openssl`, `sudo tee`, and the
`/etc/hosts` path. None of these exist (or behave the same) on a native Windows
host. The documented Windows story today is "use WSL2."

The workload itself is **already cross-platform**: every service (Postgres,
Redis, MinIO, Keycloak, api, web, worker, nginx) runs in Linux Docker
containers, and the shell scripts that bootstrap them (`render-realm.sh`,
`apply-user-profile.sh`, `build-theme-image.sh`) run _inside_ those containers
via entrypoints/volume mounts (`docker-compose.yml:132`, `:193`, `:245`) — the
host OS never executes them. Docker Desktop runs all of this natively on
Windows. The only thing that is genuinely Unix-bound is the **host-side
`Makefile`**, which is a thin wrapper around `docker compose`.

## Goal

Let a developer on native Windows (Docker Desktop, no WSL2 required) run the
full local stack with the same ergonomics as Mac/Linux, without duplicating
workflow logic across two languages.

Non-goals:

- Replacing WSL2 for anyone who already uses it (it keeps working unchanged).
- Porting the Helm / Keycloak-SPI build tooling to Windows (see "Out of scope").

## Approach

A single, dependency-free Node orchestrator — **`scripts/stack.mjs`** — is the
one source of truth for host-side stack operations. Node + pnpm are already hard
requirements (`engines`: Node ≥ 24, pnpm ≥ 10), so a `.mjs` script using only
`node:*` builtins runs identically on win32/darwin/linux with zero new
toolchain.

Alternatives considered and rejected:

- **PowerShell `.ps1` + keep `.sh`** — native-feeling on Windows but doubles
  maintenance; the two implementations drift.
- **A task runner (`just`, etc.)** — clean, but adds a tool every contributor
  must install, defeating the "fewer host dependencies" goal.

### Components

```
node scripts/stack.mjs <setup|up|down|reset|logs|ps|psql|rebuild-web>
```

Three layers wrap the orchestrator:

1. **pnpm scripts** in root `package.json` (`stack:setup`, `stack:up`,
   `stack:down`, `stack:reset`, `stack:logs`, `stack:ps`, `stack:psql`,
   `stack:rebuild-web`) — the cross-platform entrypoint Windows users run.
2. **Makefile** targets `setup`/`up`/`dev`/`down`/`reset`/`logs`/`ps`/`psql`/
   `rebuild-web` keep their names but their recipe bodies are replaced with a
   single delegating call (e.g. `setup: ; pnpm stack:setup`). The existing
   POSIX-sh logic in `env:`/`hosts:`/`up:` moves _into_ `stack.mjs`. Unix
   muscle-memory is preserved; the logic is de-duplicated.
3. **Helm + SPI targets** (`helm-*`, `kc-plugin`, `rebuild-keycloak`,
   `keycloak-image`, `helm-sync-files`, …) stay Makefile-only and Unix/WSL-only.
   They are deploy/SPI-build tooling, not part of the local-run loop, and the
   OTP authenticator JAR is already committed
   (`infra/keycloak/providers/keycloak-otp-1.0.0-SNAPSHOT.jar`).

### OS-specific behavior (the only branches in the script)

There are exactly three `process.platform` branches; everything else is
identical across platforms because `docker compose` is cross-platform.

| Concern          | Unix (darwin/linux)      | Windows (win32)                                                                                   |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| Hosts file       | auto-edit via `sudo tee` | detect + print exact lines to paste into `C:\Windows\System32\drivers\etc\hosts` as Administrator |
| `.env` perms     | `chmod 600`              | skip (no-op on NTFS)                                                                              |
| Docker preflight | `docker info` reachable? | same `docker info` check                                                                          |

## Data flow

### `setup`

Steps run in order; each is idempotent:

1. **Resolve `.env`** — if `.env` exists, leave untouched. Else copy
   `infra/env.local` → `.env` (pre-filled dev values). Else fall back to
   `infra/env.template` → `.env` and print which `change-me-*` placeholders need
   filling. (Mirrors the current `env:` target.)
2. **Permissions** — `chmod 600` on `.env` on Unix; skipped on Windows.
3. **Hosts entries** — ensure `127.0.0.1 keycloak` and `127.0.0.1 minio`
   resolve:
   - Read the OS-correct hosts path.
   - Both entries present → skip.
   - Unix, missing → append via `sudo tee` (prompts for password, as today).
   - Windows, missing → print the exact two lines + the file path + "open
     Notepad as Administrator and paste these," then continue (non-fatal).
4. **Final hint** — "Setup complete. Run `pnpm stack:up` (or `make up`)."

### `up`

1. **Docker preflight** — `docker info` reachable? Else fail fast:
   `"Docker daemon not reachable. Start Docker Desktop (Windows/Mac) or the
docker service (Linux), then retry."`
2. Assert `.env` exists (else `"No .env found — run: pnpm stack:setup"`).
3. `docker compose up -d --build`.

### Pass-through subcommands

`down`/`reset`/`logs`/`ps`/`psql` map directly to the existing `docker compose`
invocations. `rebuild-web` preserves its pre-step
(`pnpm --filter @aggregator-dpg/web build`) then `docker compose build web &&
docker compose up -d web`.

### Documentation behavior change

The QUICKSTART's `sed -i ''` admin-email edit (BSD-only; already broken on
Linux) is dropped from the docs in favor of "open `.env` and set
`ADMIN_EMAILS=`" — a manual edit identical on all three OSes.

## Error handling

This is host tooling, not application code, so it does **not** use the
`Result<T, E>` pattern. It follows CLI conventions: do the work, exit non-zero
with a clear message on failure.

- **Every external invocation is checked** — `child_process` calls go through a
  small `run()` helper that throws on non-zero exit. No silent failures.
- **Fail fast with actionable messages**, never raw stack traces for expected
  conditions (Docker down, missing `.env`, unknown subcommand → usage + exit 2).
- **Hosts step is best-effort, never fatal** — if `sudo tee` fails or on
  Windows, print the manual lines and continue; the stack still boots, only
  browser→OIDC hostname resolution needs the entry, which the message explains.
- **Idempotency over assumptions** — re-running `setup` never clobbers an
  existing `.env` and never duplicates hosts lines (match before append).

## Testing & verification

Honest constraint: development happens on macOS, so the `win32` branch cannot be
executed locally. Verification splits three ways:

1. **Unix path, end-to-end (verifiable on macOS):** `node scripts/stack.mjs
setup` reproduces `make setup` (correct `.env`, mode 600, idempotent hosts
   entries); `pnpm stack:up` boots the stack and the QUICKSTART smoke test
   passes; `make setup`/`make up` still work via the delegating targets.
2. **Platform logic by isolation (verifiable on any OS / CI):** the win32
   branches (hosts path + instruction text, `chmod` skip) are pure string/path
   logic. Factor them so `platform` is an injectable parameter and add a
   **Vitest** unit test asserting the right path + message per `process.platform`
   value. No Docker, no network (per `.claude/rules/testing.md`).
3. **Real Windows run (requires a Windows host):** one manual run on Windows +
   Docker Desktop — `pnpm stack:setup` → paste hosts lines → `pnpm stack:up` →
   smoke test at `localhost:3100`. The new "Windows" section in `QUICKSTART.md`
   doubles as this checklist; this manual run is the acceptance gate before
   merge.

## Out of scope

- WSL2-only tooling: Helm chart targets, `kc-plugin`/`rebuild-keycloak`
  (OTP SPI build via `./mvnw`), `keycloak-image`, `build-theme-image.sh`.
  Documented as "Unix/WSL2 only."
- Auto-elevation on Windows (UAC re-launch). Rejected in favor of
  detect-and-instruct (less code, no elevation handling).

## File-change summary

- **New:** `scripts/stack.mjs` — the orchestrator.
- **New:** `scripts/__tests__/stack.test.ts` (or co-located) — Vitest platform-
  logic unit tests.
- **Edit:** root `package.json` — add `stack:*` scripts.
- **Edit:** `Makefile` — `setup`/`up`/`dev`/`down`/`reset`/`logs`/`ps`/`psql`/
  `rebuild-web` recipes delegate to `pnpm stack:*`; Helm/SPI targets untouched.
- **Edit:** `QUICKSTART.md` — add a Windows section; drop `sed -i ''`.
- **Edit:** `SETUP.md` / `CLAUDE.md` — note the pnpm-script entrypoint and the
  Windows path where local-stack commands are described.
