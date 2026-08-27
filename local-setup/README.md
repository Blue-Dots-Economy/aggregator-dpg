# local-setup — unified full-ecosystem local stack

One `docker compose up -d` that brings up **both** DPGs of the Blue Dots /
Signal Stack ecosystem, wired for localhost:

- **aggregator-dpg** (this repo) — portal (web) + API + worker
- **signals-dpg** (upstream, sibling repo) — the Signals Stack backend
- shared infra — Postgres (3 DBs), two Redis, Keycloak, MinIO, Mailpit
- **signals-search** — opt-in behind `--profile search`: relevance-ranked
  discover + match scores instead of recency order

👉 **Full walkthrough: [`LOCAL_SETUP.md`](./LOCAL_SETUP.md)** (Track A = all-in-Docker,
Track B = hybrid hot-reload).

## Required layout

The compose builds _both_ repos, so it expects them checked out as **siblings**
and is always run **from this directory**:

```
<parent>/
  ├── aggregator-dpg/          (this repo)
  │     └── local-setup/       ← run docker compose from HERE
  └── signals-dpg/             (sibling; built via ../../signals-dpg)
```

## Quick start

```bash
cd aggregator-dpg/local-setup
cp .env.example .env          # then set ADMIN_EMAILS (see LOCAL_SETUP.md §2)
# once; safe to re-run
grep -qE '^[[:space:]]*127\.0\.0\.1[[:space:]]+keycloak([[:space:]]|$)' /etc/hosts \
  || sudo sh -c "printf '\n127.0.0.1 keycloak\n' >> /etc/hosts"
docker compose up -d --build
docker compose ps             # wait for keycloak + aggregator-api healthy
```

Portal → http://localhost:3100 · Signals UI → http://localhost:5173 ·
Mailpit → http://localhost:8025 · Keycloak → http://localhost:8080/admin

## Contents

| File                                 | Purpose                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| `docker-compose.yml`                 | the unified stack (both DPGs + shared infra)               |
| `.env.example`                       | single root env with working dev defaults — copy to `.env` |
| `LOCAL_SETUP.md`                     | from-scratch setup guide, both run modes, troubleshooting  |
| `infra/postgres.Dockerfile`          | Postgres 17 + PostGIS + pgvector image                     |
| `infra/postgres-init/`               | creates the `signals` + `keycloak` DBs on first boot       |
| `infra/signals-bootstrap.Dockerfile` | one-shot signals migrate + seed tools image                |

> This is **local dev only**. The repo-root `../docker-compose.yml` is the
> separate VM/prod nginx+certbot ingress variant for aggregator-dpg alone.

## Optional — relevance ranking (`--profile search`)

```bash
cp .env.search.example .env.search    # mint the apikey first — LOCAL_SETUP.md §10.3
docker compose --profile search up -d
```

Adds `sd-signals-search-api` (host **:3110** — the portal owns 3100),
`sd-signals-search-worker`, and `sd-tei-embeddings` (BAAI/bge-m3 via TEI). Both
images are pulled **prebuilt from public GHCR**, so unlike the two DPGs this
stack builds from source, signals-search needs no checkout and no `docker login`.

Opt-in because the embedder loads a ~2.3 GB model on CPU and wants 3-4 GB on top
of this stack's existing ~11 containers — budget **≥10 GB** of Docker memory with
it on. Config details in `LOCAL_SETUP.md` §10; the canonical reference for
signals-search's own settings is signals-dpg's `LOCAL_SETUP.md` §7.
