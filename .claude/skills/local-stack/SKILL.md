---
name: local-stack
description: Run modes and env layout for the local/VM stack — hybrid dev vs docker-only vs the unified full-ecosystem stack in local-setup/, the TLS/INSTANCE_ENV posture guard, and what to change when deploying to a VM. Use when starting or debugging the local stack, editing docker-compose files or .env / infra/env.template, or deploying to a VM.
---

# Local stack run modes

- **Hybrid (dev)** — `docker compose up -d` for backing services + `pnpm --filter ... dev` for api/web/worker outside the container. Uses `apps/<app>/.env` (copy from `.env.example`).
- **Docker-only (VM / prod-like)** — `make setup && make up`. All env values live in a **single root `.env`** sectioned per service (`infra/env.template` is the canonical layout). `NEXT_PUBLIC_API_URL` is baked at compile time, so VM redeploys must use `docker compose up -d --build`. The base `docker-compose.yml` is the prod/VM posture: TLS verify **on**, `INSTANCE_ENV=production`, no host-published DB/Redis/MinIO ports, and MinIO behind the **`storage`** compose profile. `make up` / `stack:up` layer `docker-compose.dev.yml`, which rebinds those ports to `127.0.0.1`, sets `INSTANCE_ENV=development`, and relaxes TLS for the local CA. api/worker run an `assertTlsPosture` startup guard that hard-fails boot when TLS verification is off under a production `INSTANCE_ENV`.
- **Unified full-ecosystem stack (`local-setup/`)** — brings up **both** aggregator-dpg _and_ the upstream signals-dpg (+ shared Postgres/Redis/Keycloak/MinIO/Mailpit) in one `docker compose up -d`, wired for localhost. It builds both repos, so it expects `aggregator-dpg` and `signals-dpg` checked out as **siblings** and is run from `local-setup/`. See `local-setup/LOCAL_SETUP.md` for the full walkthrough (Track A = all-in-Docker, Track B = hybrid). **signals-search is opt-in behind `--profile search`** (LOCAL_SETUP.md §10): it adds a query API on host **3110** (not 3100 — the portal owns that), an ingestion worker and a TEI embedding server, pulled prebuilt from public GHCR. It is not always-on because the embedder wants 3-4 GB on top of an already ~11-container stack; without it, discover returns recency-ordered results and match scores are unavailable. Every `--profile search` command needs the flag, `down` included. The compose here (repo root `docker-compose.yml`) remains the VM/prod nginx+certbot ingress variant.

## Deploying to a VM

Replace `localhost` and `keycloak` everywhere in `.env` with the VM hostname/IP, and update the `aggregator-portal` client's **Valid Redirect URIs** + **Web Origins** in the Keycloak admin console.

## Stack commands

`make setup` is a one-shot that copies `infra/env.template` → `.env` (chmod 600) and adds `127.0.0.1 keycloak` to `/etc/hosts`. `pnpm stack:setup` / `stack:up` are the cross-platform equivalents (Windows-friendly; `make` not required), and the same script covers `stack:down | stack:reset | stack:logs | stack:ps | stack:psql | stack:rebuild-web`.

Two that bite if you skip them:

- `make reset` runs `docker compose down -v` — **DESTROYS data volumes**.
- `make rebuild-web` rebuilds the web image and restarts the container — required after any `NEXT_PUBLIC_*` env change, since those are baked at build time.
- `make rebuild-keycloak` rebuilds the OTP SPI jar and restarts Keycloak.
