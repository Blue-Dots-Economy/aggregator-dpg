# Brand-specific deployments under a network

**Date:** 2026-06-25
**Status:** Approved (design) — pending implementation plan
**Area:** aggregator-dpg config, docker-compose, Keycloak theme build, brand assets

## Problem

Branding in the aggregator is selected per _network_ via a single env var
`AGGREGATOR_NETWORK` (e.g. `blue_dot`), which `docker-compose.yml` interpolates
into config paths (`config/${AGGREGATOR_NETWORK}/...`) for `keycloak.env`,
`SCHEMA_ROOT_DIR`, and `AGGREGATOR_CONFIG_PATH`.

Recent work made network folders **brand-specific**:

- `config/orange_dot` was rebranded to **OneTAC** (its `brand.json`,
  `keycloak.env`, `aggregator.config.yaml`, logos all carry OneTAC). There is no
  generic "orange dots" default left.
- The `blue_dot` **right-side logo** was swapped to a partner (UPSDM-flavoured)
  mark in commit `dfb1096` ("feat(blue-dot): update right-side brand logo; keep
  Blue Dots on hero"), affecting both the web and Keycloak logo assets, while the
  base config strings stayed "Blue Dots".

Consequence: deploying `blue_dot` or `orange_dot` anywhere now ships the
partner/brand artwork instead of the standard dots. We need the network folders
to be **standard/agnostic defaults** again, with each brand isolated so a single
network can be deployed under multiple brands.

## Goals

- A network folder (`config/<network>/`) is the **standard, brand-agnostic
  default**.
- Each brand is an **opt-in, self-contained sub-folder** (`config/<network>/<brand>/`).
- Adding a future brand = drop in one new sub-folder + asset folders. **No app
  code changes.**
- `AGGREGATOR_NETWORK` unset-of-brand → standard dots deploy automatically.
- The brand selection must **not** change the upstream signals-network identity
  (`item_network`); a brand is a UI/config skin over the same network.

## Non-goals

- No changes to `packages/network-config` loader logic (it already resolves
  `brand.json` as a sibling of the config path).
- No changes to the web `theme-provider` or the Keycloak FTL/`theme.properties`
  template — both are already brand-agnostic (select by slug, read colors from env).
- No new inheritance/merge layer between a brand folder and its parent network
  (decision below: self-contained copy).

## Key decisions

| Decision            | Choice                                          | Rationale                                                                                                   |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Brand config model  | **Self-contained copy**                         | Brand folder fully defines its config; no new loader/fallback logic. Trade-off: some duplication, accepted. |
| Selector mechanism  | **Two env vars**                                | Decouples folder selection from upstream identity with pure docker-compose interpolation, no scripting.     |
| Base orange_dot     | **Restore pre-OneTAC Udupi** (commit `4bdf0b9`) | A real, complete historical baseline (config + web/keycloak logos all present).                             |
| Base blue_dot logos | **Restore from `dfb1096^` (`a57916f`)**         | Standard blue-dot logos before the partner-logo swap.                                                       |

## Architecture

### 1. Folder convention

```
config/
  blue_dot/                 # standard Blue Dots (default)
    aggregator.config.yaml
    brand.json
    keycloak.env
    schemas/ ...  bulk-samples/ ...
    upsdm/                  # brand: self-contained copy, edited for UPSDM
      aggregator.config.yaml
      brand.json
      keycloak.env
      schemas/ ...
  orange_dot/               # standard Orange Dots (restored Udupi baseline)
    ...
    onetac/                 # brand: OneTAC config + logos
      ...
  purple_dot/               # unaffected
```

Brand assets live in **three** places, all keyed by a brand slug:

1. `config/<network>/<brand>/` — full config copy. `keycloak.env` sets brand
   colors, hero strings, and `BRAND_LOGO_SLUG=<brand-slug>`.
2. `apps/web/public/brand/<brand-slug>/` — web logo assets (referenced by the
   brand's `brand.json` logo paths).
3. `infra/keycloak/themes/otp/login/resources/img/brand/<brand-slug>/` — Keycloak
   login-page logos (selected by `BRAND_LOGO_SLUG`).

### 2. Selector — two env vars

- `AGGREGATOR_NETWORK=<network>` — base network. Drives the upstream identity
  (`SIGNALSTACK_ITEM_NETWORK`) and `network.source`. **Never** includes a brand.
- `AGGREGATOR_BRAND=<brand>` — optional. Appended to config paths only. Unset →
  standard dots.

`docker-compose.yml` — every path of the form
`config/${AGGREGATOR_NETWORK:-blue_dot}/...` (currently lines ~188, 309, 390, 456)
becomes:

```yaml
config/${AGGREGATOR_NETWORK:-blue_dot}${AGGREGATOR_BRAND:+/${AGGREGATOR_BRAND}}/...
```

`${AGGREGATOR_BRAND:+/${AGGREGATOR_BRAND}}` expands to `/<brand>` when set and to
empty when unset — pure interpolation, no scripting.

The `SIGNALSTACK_ITEM_NETWORK: ${AGGREGATOR_NETWORK:-blue_dot}` lines (currently
398, 466) stay **unchanged** — this is the whole reason for splitting the vars.
Because the loader resolves `brand.json` as a sibling of `AGGREGATOR_CONFIG_PATH`
and `SCHEMA_ROOT_DIR` is set the same way, both follow the brand folder
automatically. No `packages/network-config` change.

### 3. Keycloak image build supports brands

Local dev (docker-compose) is already covered by §2 — line 188's `keycloak.env`
`env_file` path gets the `${AGGREGATOR_BRAND:+/...}` suffix, and the disk-mounted
theme reads colors/strings/slug via `${env.VAR}` and selects the logo by slug.

For the **baked k8s theme image**, `infra/keycloak/build-theme-image.sh` currently
takes `<network>` and reads `config/<network>/keycloak.env`, tagging
`aggregator-kc-theme:<network>-<tag>`. Change it to accept an optional brand:

- Reads `config/<network>/<brand>/keycloak.env` when a brand is given (else
  `config/<network>/keycloak.env`).
- Tags `aggregator-kc-theme:<network>-<brand>-<tag>` (else `<network>-<tag>`).

`themes.Dockerfile` needs **no change** — it bakes whatever `keycloak.env` build
args it receives into `theme.properties` and copies the whole theme tree
(including the new `img/brand/<slug>/` folder). The theme stays vanilla; the image
hash uniquely identifies the brand.

## Migrations

### blue_dot

1. Copy current `config/blue_dot/*` → `config/blue_dot/upsdm/`; edit its
   `keycloak.env`/`brand.json` for UPSDM (`BRAND_LOGO_SLUG=upsdm`, brand strings).
2. Move current (UPSDM-flavoured) logo assets to slug `upsdm`:
   `apps/web/public/brand/upsdm/` and
   `infra/keycloak/.../img/brand/upsdm/`.
3. **Restore standard blue-dot logos from `dfb1096^` (`a57916f`)** into the base
   slug `blue-dot` (both web + keycloak asset folders).
4. Base `config/blue_dot` config strings already read "Blue Dots" — leave as the
   standard default.

### orange_dot

1. Copy current OneTAC config → `config/orange_dot/onetac/` (slug `onetac`);
   move current OneTAC logos to slug `onetac` (web + keycloak).
2. **Restore base `config/orange_dot` and the `orange-dot` logo slug from commit
   `4bdf0b9`** (pre-OneTAC Udupi baseline — config, web logos, keycloak logos all
   present there).

## Guardrails & docs

- **Fail-fast:** if `AGGREGATOR_BRAND` is set but the folder is missing, the
  config paths resolve to a nonexistent dir and the loader already errors
  `CONFIG_FILE_MISSING`. Add a one-line preflight (Makefile/compose check) that
  prints a clear "brand folder `config/<network>/<brand>` not found" message.
- Document `AGGREGATOR_NETWORK` + `AGGREGATOR_BRAND` in `.env.example` (currently
  only `AGGREGATOR_NETWORK` at line 35).
- Add `config/README.md` documenting the network/brand convention and the three
  asset locations.

## Affected files (summary)

- `docker-compose.yml` — append `${AGGREGATOR_BRAND:+/...}` to the four config
  paths; leave `SIGNALSTACK_ITEM_NETWORK` as base.
- `infra/keycloak/build-theme-image.sh` — optional brand arg + tag.
- `.env.example` — document both vars.
- `config/README.md` — new.
- New: `config/blue_dot/upsdm/`, `config/orange_dot/onetac/`,
  `apps/web/public/brand/upsdm/`, `infra/keycloak/.../img/brand/upsdm/`,
  `.../img/brand/onetac/` (if not already named so).
- Restored: base `config/orange_dot/*` (from `4bdf0b9`), `orange-dot` logos (from
  `4bdf0b9`), `blue-dot` logos (from `a57916f`).

## Verification

- `AGGREGATOR_NETWORK=blue_dot` (no brand) → standard Blue Dots web + Keycloak
  login; `item_network: blue_dot` on onboard.
- `AGGREGATOR_NETWORK=blue_dot AGGREGATOR_BRAND=upsdm` → UPSDM logo, brand colors;
  `item_network` still `blue_dot`.
- `AGGREGATOR_NETWORK=orange_dot` → standard (Udupi) Orange Dots.
- `AGGREGATOR_NETWORK=orange_dot AGGREGATOR_BRAND=onetac` → OneTAC.
- `build-theme-image.sh blue_dot upsdm` → image tagged `...:blue_dot-upsdm-*`
  with UPSDM colors/logo baked.
- Missing brand folder → clear preflight error.
