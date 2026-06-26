# Brand-Specific Deployments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each network folder a brand-agnostic default again, with each brand isolated in a self-contained `config/<network>/<brand>/` sub-folder selected by an optional `AGGREGATOR_BRAND` env var — without changing the upstream signals-network identity.

**Architecture:** Add a second selector env var `AGGREGATOR_BRAND` that docker-compose appends to config paths via pure interpolation (`${AGGREGATOR_BRAND:+/${AGGREGATOR_BRAND}}`), while `SIGNALSTACK_ITEM_NETWORK` stays bound to the base `AGGREGATOR_NETWORK`. The web theme and Keycloak theme are already brand-agnostic (select logo by `BRAND_LOGO_SLUG`, read colors from env), so the only code change is the Keycloak theme-image build script. The rest is config/asset migration: move current brand artwork into brand sub-folders + new logo slugs, and restore standard dots from git history.

**Tech Stack:** docker-compose (variable interpolation), Bash (`build-theme-image.sh`), YAML/JSON config, PNG/SVG brand assets, git history restore.

## Global Constraints

- Brand config model is **self-contained copy** — a brand folder fully defines its own `aggregator.config.yaml`, `brand.json`, `keycloak.env`, `schemas/`, `bulk-samples/`. No inheritance/merge from the parent network folder.
- `SIGNALSTACK_ITEM_NETWORK` MUST always equal the base `AGGREGATOR_NETWORK` (e.g. `blue_dot`), never `blue_dot/upsdm`. A brand is a UI/config skin only.
- No changes to `packages/network-config` loader, the web `theme-provider`, or the Keycloak FTL / `theme.properties` template.
- Logo selection is by slug: `config/<...>/keycloak.env` sets `BRAND_LOGO_SLUG=<slug>`; `brand.json` `logo.*` paths point at `/brand/<slug>/...`. Each slug needs assets in BOTH `apps/web/public/brand/<slug>/` and `infra/keycloak/themes/otp/login/resources/img/brand/<slug>/`.
- Brand slugs: UPSDM → `upsdm`; OneTAC → `onetac`. Standard slugs stay `blue-dot` / `orange-dot`.
- Restore points: standard blue-dot logos = commit `a57916f` (== `dfb1096^`); standard orange_dot config + logos = commit `4bdf0b9` (pre-OneTAC Udupi).
- Run all commands from repo root `aggregator-dpg/`. Do not commit `.env` (only `.env.example`).

---

### Task 1: Two-var selector in docker-compose + .env.example

**Files:**

- Modify: `docker-compose.yml` (config-path lines ~188, 309, 390, 456; leave `SIGNALSTACK_ITEM_NETWORK` lines ~398, 466 unchanged)
- Modify: `.env.example` (around line 35, after `AGGREGATOR_NETWORK=blue_dot`)

**Interfaces:**

- Produces: env var `AGGREGATOR_BRAND` (optional). When set, config/keycloak/schema paths resolve to `config/<network>/<brand>/...`; when unset, to `config/<network>/...`.

- [ ] **Step 1: Verify current resolved config (baseline, no brand)**

Run: `AGGREGATOR_NETWORK=blue_dot docker compose config | grep -E "config/blue_dot|SIGNALSTACK_ITEM_NETWORK"`
Expected: paths show `./config/blue_dot/...`; `SIGNALSTACK_ITEM_NETWORK: blue_dot`.

- [ ] **Step 2: Edit the four config-path lines**

In `docker-compose.yml`, change each occurrence of
`config/${AGGREGATOR_NETWORK:-blue_dot}/` (the `env_file` keycloak.env path, the two `SCHEMA_ROOT_DIR`, and the two `AGGREGATOR_CONFIG_PATH` — and any sibling `SCHEMA_ROOT_DIR` on the web/keycloak services) to:

```
config/${AGGREGATOR_NETWORK:-blue_dot}${AGGREGATOR_BRAND:+/${AGGREGATOR_BRAND}}/
```

Leave every `SIGNALSTACK_ITEM_NETWORK: ${AGGREGATOR_NETWORK:-blue_dot}` line **exactly as-is**.

- [ ] **Step 3: Verify brand path resolves and identity stays base**

Run: `AGGREGATOR_NETWORK=blue_dot AGGREGATOR_BRAND=upsdm docker compose config | grep -E "config/blue_dot/upsdm|SIGNALSTACK_ITEM_NETWORK"`
Expected: paths show `./config/blue_dot/upsdm/...`; `SIGNALSTACK_ITEM_NETWORK: blue_dot` (NOT `blue_dot/upsdm`).

- [ ] **Step 4: Verify default (no brand) is unchanged**

Run: `AGGREGATOR_NETWORK=blue_dot docker compose config | grep -E "config/blue_dot/(keycloak|aggregator|schemas)"`
Expected: paths show `./config/blue_dot/keycloak.env` etc. with NO `/upsdm` segment.

- [ ] **Step 5: Document the var in .env.example**

Add directly beneath the existing `AGGREGATOR_NETWORK=blue_dot` line:

```
# Optional brand skin under the network. When set, config/keycloak/schema
# paths resolve to config/${AGGREGATOR_NETWORK}/${AGGREGATOR_BRAND}/.
# Leave UNSET to deploy the standard (brand-agnostic) network.
# The upstream signals identity (SIGNALSTACK_ITEM_NETWORK) always stays
# the base AGGREGATOR_NETWORK regardless of this value.
# Example: AGGREGATOR_BRAND=upsdm  (-> config/blue_dot/upsdm)
AGGREGATOR_BRAND=
```

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "feat(deploy): add AGGREGATOR_BRAND selector for brand sub-folders"
```

---

### Task 2: Keycloak theme-image build supports brands

**Files:**

- Modify: `infra/keycloak/build-theme-image.sh`

**Interfaces:**

- Consumes: `config/<network>[/<brand>]/keycloak.env`.
- Produces: CLI `build-theme-image.sh <network> [<brand>] [<image-tag>] [<registry>]`; image tag `aggregator-kc-theme:<network>[-<brand>]-<tag>`. Supports `DRY_RUN=1` to print the resolved env file + image tag and skip `docker build`.

- [ ] **Step 1: Add brand arg + DRY_RUN, resolve env file and tag**

Rewrite the argument/resolution block of `infra/keycloak/build-theme-image.sh` to:

```bash
NETWORK="${1:-blue_dot}"
BRAND="${2:-}"
TAG="${3:-local}"
REGISTRY="${4:-}"

if [[ -n "$BRAND" ]]; then
  ENV_FILE="config/${NETWORK}/${BRAND}/keycloak.env"
  IMAGE_NAME="aggregator-kc-theme:${NETWORK}-${BRAND}-${TAG}"
else
  ENV_FILE="config/${NETWORK}/keycloak.env"
  IMAGE_NAME="aggregator-kc-theme:${NETWORK}-${TAG}"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE — run from repo root" >&2
  exit 1
fi
```

Replace later uses of `$IMAGE` with `$IMAGE_NAME`, keep the `${REGISTRY}/` prefix logic, and pass `--build-arg NETWORK=${NETWORK}` as before (do NOT bake the brand into `NETWORK`; the slug comes from `BRAND_LOGO_SLUG` in the env file). Before the `docker build` call add:

```bash
if [[ -n "${DRY_RUN:-}" ]]; then
  echo "DRY_RUN: env_file=$ENV_FILE image=$IMAGE_NAME"
  exit 0
fi
```

- [ ] **Step 2: Lint the script**

Run: `bash -n infra/keycloak/build-theme-image.sh && shellcheck infra/keycloak/build-theme-image.sh || true`
Expected: no syntax errors (`bash -n` exits 0).

- [ ] **Step 3: Verify base resolution (dry run)**

Run: `DRY_RUN=1 ./infra/keycloak/build-theme-image.sh blue_dot`
Expected: `DRY_RUN: env_file=config/blue_dot/keycloak.env image=aggregator-kc-theme:blue_dot-local`

- [ ] **Step 4: Verify brand resolution (dry run) — depends on Task 4 folder, run after it; for now expect the missing-file guard**

Run: `DRY_RUN=1 ./infra/keycloak/build-theme-image.sh blue_dot upsdm v1`
Expected (before Task 4): `missing config/blue_dot/upsdm/keycloak.env`. (After Task 4: `DRY_RUN: env_file=config/blue_dot/upsdm/keycloak.env image=aggregator-kc-theme:blue_dot-upsdm-v1`.)

- [ ] **Step 5: Update the usage comment block**

Update the header `Usage:` lines to document the new `[<brand>]` positional arg and the `<network>-<brand>-<tag>` image tag.

- [ ] **Step 6: Commit**

```bash
git add infra/keycloak/build-theme-image.sh
git commit -m "feat(keycloak): build per-brand theme images from config/<network>/<brand>"
```

---

### Task 3: Create blue_dot/upsdm brand + move current logos to `upsdm` slug

**Files:**

- Create: `config/blue_dot/upsdm/` (copy of current `config/blue_dot/*`)
- Create: `apps/web/public/brand/upsdm/` (moved from current `blue-dot` artwork)
- Create: `infra/keycloak/themes/otp/login/resources/img/brand/upsdm/` (moved from current `blue-dot` artwork)
- Modify: `config/blue_dot/upsdm/keycloak.env`, `config/blue_dot/upsdm/brand.json`

**Interfaces:**

- Consumes: `AGGREGATOR_BRAND` from Task 1.
- Produces: deployable brand `blue_dot/upsdm` with slug `upsdm`.

- [ ] **Step 1: Copy current blue_dot config into the upsdm sub-folder**

```bash
mkdir -p config/blue_dot/upsdm
cp -a config/blue_dot/aggregator.config.yaml config/blue_dot/upsdm/
cp -a config/blue_dot/brand.json config/blue_dot/upsdm/
cp -a config/blue_dot/keycloak.env config/blue_dot/upsdm/
[ -d config/blue_dot/schemas ] && cp -a config/blue_dot/schemas config/blue_dot/upsdm/ || true
[ -d config/blue_dot/bulk-samples ] && cp -a config/blue_dot/bulk-samples config/blue_dot/upsdm/ || true
```

- [ ] **Step 2: Copy current (UPSDM-flavoured) web logos to the upsdm slug**

```bash
mkdir -p apps/web/public/brand/upsdm
cp -a apps/web/public/brand/blue-dot/. apps/web/public/brand/upsdm/
```

- [ ] **Step 3: Copy current (UPSDM-flavoured) keycloak logos to the upsdm slug**

```bash
mkdir -p infra/keycloak/themes/otp/login/resources/img/brand/upsdm
cp -a infra/keycloak/themes/otp/login/resources/img/brand/blue-dot/. infra/keycloak/themes/otp/login/resources/img/brand/upsdm/
```

- [ ] **Step 4: Point the upsdm brand at the upsdm slug**

In `config/blue_dot/upsdm/keycloak.env`, set `BRAND_LOGO_SLUG=upsdm` and update brand strings for UPSDM (`BRAND_SHORT_NAME`, `BRAND_LONG_NAME`, hero strings) as appropriate.
In `config/blue_dot/upsdm/brand.json`, change every `logo.*` path from `/brand/blue-dot/...` to `/brand/upsdm/...` and set `brand.name`/`wordmark` to the UPSDM identity.

- [ ] **Step 5: Verify slug wiring is self-consistent**

Run: `grep -n "BRAND_LOGO_SLUG" config/blue_dot/upsdm/keycloak.env; grep -n "/brand/" config/blue_dot/upsdm/brand.json`
Expected: `BRAND_LOGO_SLUG=upsdm`; all `brand.json` logo paths point to `/brand/upsdm/`.

- [ ] **Step 6: Verify build-script brand resolution now succeeds**

Run: `DRY_RUN=1 ./infra/keycloak/build-theme-image.sh blue_dot upsdm v1`
Expected: `DRY_RUN: env_file=config/blue_dot/upsdm/keycloak.env image=aggregator-kc-theme:blue_dot-upsdm-v1`

- [ ] **Step 7: Commit**

```bash
git add config/blue_dot/upsdm apps/web/public/brand/upsdm infra/keycloak/themes/otp/login/resources/img/brand/upsdm
git commit -m "feat(blue_dot): extract UPSDM brand into config/blue_dot/upsdm + upsdm logo slug"
```

---

### Task 4: Restore standard blue-dot logos into the base slug

**Files:**

- Modify: `apps/web/public/brand/blue-dot/*` (restore from `a57916f`)
- Modify: `infra/keycloak/themes/otp/login/resources/img/brand/blue-dot/*` (restore from `a57916f`)

**Interfaces:**

- Produces: base `blue_dot` (slug `blue-dot`) showing the standard Blue Dots logo, not the partner mark.

- [ ] **Step 1: Confirm the restore point differs from current**

Run: `git diff --stat a57916f -- apps/web/public/brand/blue-dot infra/keycloak/themes/otp/login/resources/img/brand/blue-dot`
Expected: a non-empty diff (the partner-logo swap from `dfb1096`).

- [ ] **Step 2: Restore the standard logos from history**

```bash
git checkout a57916f -- apps/web/public/brand/blue-dot
git checkout a57916f -- infra/keycloak/themes/otp/login/resources/img/brand/blue-dot
```

- [ ] **Step 3: Verify restore matches the historical version**

Run: `git diff --stat a57916f -- apps/web/public/brand/blue-dot infra/keycloak/themes/otp/login/resources/img/brand/blue-dot`
Expected: empty (working tree now matches `a57916f` for these paths).

- [ ] **Step 4: Confirm base blue_dot config still points at the blue-dot slug**

Run: `grep -n "BRAND_LOGO_SLUG" config/blue_dot/keycloak.env; grep -n "/brand/" config/blue_dot/brand.json`
Expected: `BRAND_LOGO_SLUG=blue-dot`; logo paths `/brand/blue-dot/...`. (If not, set them — base must use the `blue-dot` slug.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/public/brand/blue-dot infra/keycloak/themes/otp/login/resources/img/brand/blue-dot
git commit -m "fix(blue_dot): restore standard blue-dot logos to base (pre-partner-swap a57916f)"
```

---

### Task 5: Extract OneTAC into orange_dot/onetac + move current logos to `onetac` slug

**Files:**

- Create: `config/orange_dot/onetac/` (copy of current OneTAC `config/orange_dot/*`)
- Create: `apps/web/public/brand/onetac/` (moved from current `orange-dot` artwork)
- Create: `infra/keycloak/themes/otp/login/resources/img/brand/onetac/` (moved from current `orange-dot` artwork)
- Modify: `config/orange_dot/onetac/keycloak.env`, `config/orange_dot/onetac/brand.json`

**Interfaces:**

- Produces: deployable brand `orange_dot/onetac` with slug `onetac`.

> Order matters: this task captures the CURRENT (OneTAC) content into `onetac/` BEFORE Task 6 overwrites the base from history.

- [ ] **Step 1: Copy current OneTAC config into the onetac sub-folder**

```bash
mkdir -p config/orange_dot/onetac
cp -a config/orange_dot/aggregator.config.yaml config/orange_dot/onetac/
cp -a config/orange_dot/brand.json config/orange_dot/onetac/
cp -a config/orange_dot/keycloak.env config/orange_dot/onetac/
[ -d config/orange_dot/schemas ] && cp -a config/orange_dot/schemas config/orange_dot/onetac/ || true
[ -d config/orange_dot/bulk-samples ] && cp -a config/orange_dot/bulk-samples config/orange_dot/onetac/ || true
```

- [ ] **Step 2: Copy current OneTAC web + keycloak logos to the onetac slug**

```bash
mkdir -p apps/web/public/brand/onetac
cp -a apps/web/public/brand/orange-dot/. apps/web/public/brand/onetac/
mkdir -p infra/keycloak/themes/otp/login/resources/img/brand/onetac
cp -a infra/keycloak/themes/otp/login/resources/img/brand/orange-dot/. infra/keycloak/themes/otp/login/resources/img/brand/onetac/
```

- [ ] **Step 3: Point the onetac brand at the onetac slug**

In `config/orange_dot/onetac/keycloak.env`, set `BRAND_LOGO_SLUG=onetac` (keep all other OneTAC strings/colors).
In `config/orange_dot/onetac/brand.json`, change every `logo.*` path from `/brand/orange-dot/...` to `/brand/onetac/...` (keep OneTAC name/palette/theme).

- [ ] **Step 4: Verify slug wiring**

Run: `grep -n "BRAND_LOGO_SLUG" config/orange_dot/onetac/keycloak.env; grep -n "/brand/" config/orange_dot/onetac/brand.json`
Expected: `BRAND_LOGO_SLUG=onetac`; all logo paths `/brand/onetac/`.

- [ ] **Step 5: Commit**

```bash
git add config/orange_dot/onetac apps/web/public/brand/onetac infra/keycloak/themes/otp/login/resources/img/brand/onetac
git commit -m "feat(orange_dot): extract OneTAC brand into config/orange_dot/onetac + onetac logo slug"
```

---

### Task 6: Restore standard orange_dot (Udupi baseline) into the base folder + slug

**Files:**

- Modify: `config/orange_dot/{aggregator.config.yaml,brand.json,keycloak.env,schemas/**}` (restore from `4bdf0b9`)
- Modify: `apps/web/public/brand/orange-dot/*` (restore from `4bdf0b9`)
- Modify: `infra/keycloak/themes/otp/login/resources/img/brand/orange-dot/*` (restore from `4bdf0b9`)

**Interfaces:**

- Produces: base `orange_dot` (slug `orange-dot`) deploying the standard pre-OneTAC Udupi config + logos.

- [ ] **Step 1: Confirm onetac extraction is committed before overwriting base**

Run: `test -f config/orange_dot/onetac/keycloak.env && echo OK`
Expected: `OK` (Task 5 done). Do not proceed otherwise.

- [ ] **Step 2: Restore base orange_dot config from history**

```bash
git checkout 4bdf0b9 -- config/orange_dot/aggregator.config.yaml config/orange_dot/brand.json config/orange_dot/keycloak.env config/orange_dot/schemas
```

- [ ] **Step 3: Restore base orange-dot logos from history**

```bash
git checkout 4bdf0b9 -- apps/web/public/brand/orange-dot
git checkout 4bdf0b9 -- infra/keycloak/themes/otp/login/resources/img/brand/orange-dot
```

- [ ] **Step 4: Verify base now matches the Udupi baseline and uses the orange-dot slug**

Run: `git diff --stat 4bdf0b9 -- config/orange_dot/aggregator.config.yaml config/orange_dot/brand.json config/orange_dot/keycloak.env apps/web/public/brand/orange-dot; grep -n "BRAND_LOGO_SLUG" config/orange_dot/keycloak.env`
Expected: empty diff for the listed base paths (the `onetac/` sub-folder is untouched); `BRAND_LOGO_SLUG=orange-dot`.

- [ ] **Step 5: Verify both orange deployments resolve**

Run: `AGGREGATOR_NETWORK=orange_dot docker compose config | grep -E "config/orange_dot/(keycloak|aggregator)"; AGGREGATOR_NETWORK=orange_dot AGGREGATOR_BRAND=onetac docker compose config | grep "config/orange_dot/onetac"`
Expected: first shows base `config/orange_dot/...`; second shows `config/orange_dot/onetac/...`.

- [ ] **Step 6: Commit**

```bash
git add config/orange_dot apps/web/public/brand/orange-dot infra/keycloak/themes/otp/login/resources/img/brand/orange-dot
git commit -m "fix(orange_dot): restore standard Udupi baseline to base; OneTAC now lives in onetac/"
```

---

### Task 7: Missing-brand preflight guardrail

**Files:**

- Modify: `Makefile` (add a `check-brand` target wired into the existing up/dev target, or a standalone target)

**Interfaces:**

- Consumes: `AGGREGATOR_NETWORK`, `AGGREGATOR_BRAND`.
- Produces: a clear failure when `AGGREGATOR_BRAND` is set but the folder is absent.

- [ ] **Step 1: Add the preflight target**

Add to `Makefile`:

```make
.PHONY: check-brand
check-brand:
	@net="$${AGGREGATOR_NETWORK:-blue_dot}"; \
	if [ -n "$$AGGREGATOR_BRAND" ]; then \
	  dir="config/$$net/$$AGGREGATOR_BRAND"; \
	  if [ ! -d "$$dir" ]; then \
	    echo "ERROR: AGGREGATOR_BRAND=$$AGGREGATOR_BRAND set but $$dir not found." >&2; \
	    echo "       Create the brand folder or unset AGGREGATOR_BRAND for the standard $$net." >&2; \
	    exit 1; \
	  fi; \
	  echo "brand ok: $$dir"; \
	else \
	  echo "no brand set — using standard config/$$net"; \
	fi
```

Make the stack's up/dev target depend on `check-brand` (add `check-brand` as a prerequisite to the existing target that runs `docker compose up`).

- [ ] **Step 2: Verify guardrail fires on missing brand**

Run: `AGGREGATOR_NETWORK=blue_dot AGGREGATOR_BRAND=does_not_exist make check-brand; echo "exit=$?"`
Expected: error message naming `config/blue_dot/does_not_exist`; `exit=2` (make returns non-zero).

- [ ] **Step 3: Verify guardrail passes for a real brand and for no brand**

Run: `AGGREGATOR_NETWORK=blue_dot AGGREGATOR_BRAND=upsdm make check-brand; AGGREGATOR_NETWORK=blue_dot make check-brand`
Expected: `brand ok: config/blue_dot/upsdm`; then `no brand set — using standard config/blue_dot`.

- [ ] **Step 4: Commit**

```bash
git add Makefile
git commit -m "feat(deploy): preflight check for missing AGGREGATOR_BRAND folder"
```

---

### Task 8: Document the network/brand convention

**Files:**

- Create: `config/README.md`

**Interfaces:**

- Produces: developer-facing documentation of the convention.

- [ ] **Step 1: Write config/README.md**

Create `config/README.md` documenting:

- Folder convention: `config/<network>/` = standard default; `config/<network>/<brand>/` = self-contained brand copy.
- The two env vars (`AGGREGATOR_NETWORK` base + identity; `AGGREGATOR_BRAND` optional skin) and that `SIGNALSTACK_ITEM_NETWORK` always stays the base.
- The three asset locations a brand/slug needs: `config/<network>/<brand>/`, `apps/web/public/brand/<slug>/`, `infra/keycloak/themes/otp/login/resources/img/brand/<slug>/`.
- How to add a new brand (copy folder, set `BRAND_LOGO_SLUG`, add slug assets in both web + keycloak, build theme image with `build-theme-image.sh <network> <brand>`).
- The current brands: `blue_dot/upsdm`, `orange_dot/onetac`.

- [ ] **Step 2: Verify it renders / links are valid**

Run: `test -f config/README.md && grep -c "AGGREGATOR_BRAND" config/README.md`
Expected: count >= 1.

- [ ] **Step 3: Commit**

```bash
git add config/README.md
git commit -m "docs(config): document network/brand folder convention"
```

---

## Self-Review

**Spec coverage:**

- Folder convention → Tasks 3,5,8. ✓
- Two-var selector + compose interpolation → Task 1. ✓
- `SIGNALSTACK_ITEM_NETWORK` stays base → Task 1 (steps 2–3 verify). ✓
- Self-contained copy model → Tasks 3,5 (`cp -a` full folder). ✓
- Keycloak image brand support → Task 2. ✓
- blue_dot → upsdm migration + restore from `a57916f` → Tasks 3,4. ✓
- orange_dot → onetac migration + restore from `4bdf0b9` → Tasks 5,6. ✓
- Three asset locations per slug → Tasks 3,5 (web + keycloak), §Global Constraints. ✓
- Fail-fast guardrail → Task 7. ✓
- `.env.example` docs → Task 1 step 5. ✓
- `config/README.md` → Task 8. ✓

**Placeholder scan:** No TBD/TODO; every code/command step shows concrete content. ✓

**Type/name consistency:** Slugs (`upsdm`, `onetac`, `blue-dot`, `orange-dot`), env vars (`AGGREGATOR_BRAND`, `AGGREGATOR_NETWORK`, `BRAND_LOGO_SLUG`, `SIGNALSTACK_ITEM_NETWORK`), restore commits (`a57916f`, `4bdf0b9`), and the build-script interface (`build-theme-image.sh <network> [<brand>] [<tag>] [<registry>]`, image tag `aggregator-kc-theme:<network>[-<brand>]-<tag>`, `DRY_RUN`) are used identically across tasks. ✓

**Ordering note:** Task 5 (capture OneTAC) MUST precede Task 6 (restore base orange_dot). Task 3 (capture current blue_dot) MUST precede Task 4 (restore base blue logos). Both guarded by an explicit precondition step.
