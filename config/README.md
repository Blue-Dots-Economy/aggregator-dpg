# config/ — Network and Brand Convention

This directory holds all runtime configuration for the Aggregator DPG stack. Two concepts govern how it is laid out: **network** (the upstream Signals Stack identity) and **brand** (an optional UI/config skin over that network).

---

## Folder layout

```
config/
├── <network>/                         # Standard, brand-agnostic default
│   ├── aggregator.config.yaml         # Core app config for the network
│   ├── brand.json                     # Logo paths pointing to /brand/<network-slug>/
│   ├── keycloak.env                   # Brand strings + colours for Keycloak login
│   ├── schemas/                       # RJSF form schemas (aggregator profile, registration)
│   │   └── aggregator/
│   └── bulk-samples/                  # (optional) sample CSV files
│       ├── seeker.csv
│       └── provider.csv
│
└── <network>/
    └── <brand>/                       # Self-contained brand copy (full override)
        ├── aggregator.config.yaml
        ├── brand.json                 # Logo paths pointing to /brand/<slug>/
        ├── keycloak.env               # BRAND_LOGO_SLUG=<slug> + overridden strings/colours
        ├── schemas/                   # (optional) brand-specific form schemas
        └── bulk-samples/             # (optional) brand-specific sample CSVs
```

A brand folder is a **complete copy** of its parent network folder — not a partial override. Every file that exists in the network folder must exist in the brand folder.

### Current networks and brands

| Network      | Standard default     | Brand slug | Brand path                  |
| ------------ | -------------------- | ---------- | --------------------------- |
| `blue_dot`   | `config/blue_dot/`   | `upsdm`    | `config/blue_dot/upsdm/`    |
| `orange_dot` | `config/orange_dot/` | `onetac`   | `config/orange_dot/onetac/` |

---

## Selector env vars

Two environment variables in `.env` control which config folder is active.

| Variable             | Required | Example    | What it controls                                                               |
| -------------------- | -------- | ---------- | ------------------------------------------------------------------------------ |
| `AGGREGATOR_NETWORK` | Yes      | `blue_dot` | Base network. Drives `SIGNALSTACK_ITEM_NETWORK` and `network.source` upstream. |
| `AGGREGATOR_BRAND`   | No       | `upsdm`    | Brand skin. When set, appends `/<brand>` to all config/Keycloak/schema paths.  |

Docker Compose resolves the active config root with:

```
config/${AGGREGATOR_NETWORK:-blue_dot}${AGGREGATOR_BRAND:+/${AGGREGATOR_BRAND}}
```

So:

- `AGGREGATOR_NETWORK=blue_dot` (no brand) → `config/blue_dot/`
- `AGGREGATOR_NETWORK=blue_dot AGGREGATOR_BRAND=upsdm` → `config/blue_dot/upsdm/`

### Critical: `SIGNALSTACK_ITEM_NETWORK` always stays the base network

A brand is a **UI/config skin** — it does not change the upstream identity. `SIGNALSTACK_ITEM_NETWORK` is always set to `$AGGREGATOR_NETWORK`, never to `$AGGREGATOR_BRAND`. This means all API calls to the Signals Stack (member lookups, bulk uploads, network attribution) continue to use the base network regardless of which brand is active.

---

## Three asset locations per brand slug

The `BRAND_LOGO_SLUG` value in `keycloak.env` (e.g. `upsdm`) and the `/brand/<slug>/` paths in `brand.json` must all agree. For a slug to work end-to-end, logo assets must exist in three places:

| Location                                                      | Purpose                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `config/<network>/<brand>/`                                   | Config copy — `aggregator.config.yaml`, `brand.json`, `keycloak.env`, `schemas/` |
| `apps/web/public/brand/<slug>/`                               | Web logo assets served by Next.js at `/brand/<slug>/logo.png` etc.               |
| `infra/keycloak/themes/otp/login/resources/img/brand/<slug>/` | Keycloak login page logos                                                        |

---

## How logos are selected

### Web app (runtime)

The web app fetches `brand.json` via the API. The API resolves `brand.json` from the active config path (driven by `AGGREGATOR_NETWORK` + `AGGREGATOR_BRAND`). Logo paths in `brand.json` are relative to Next.js `public/`, so `/brand/upsdm/logo.png` resolves to `apps/web/public/brand/upsdm/logo.png`.

### Keycloak in local docker-compose (runtime)

The Keycloak container mounts the theme from disk (`infra/keycloak/themes`). On each boot it reads `BRAND_LOGO_SLUG` from the selected `keycloak.env` and `template.ftl` uses it to pick the logo at `resources/img/brand/<slug>/`. No rebuild is needed — changing `AGGREGATOR_BRAND` in `.env` and restarting the container switches the brand.

### Keycloak baked k8s theme image (build-time)

For Kubernetes, `build-theme-image.sh` bakes the brand values (including `BRAND_LOGO_SLUG` and all colours/strings) from `keycloak.env` into `theme.properties` at image build time. All slug folders are copied into every image, but the **active slug is frozen per image**. Image tags follow the pattern `aggregator-kc-theme:<network>-<brand>-<tag>`. Deploy the image that matches your intended brand.

```bash
# Build a per-brand theme image
./infra/keycloak/build-theme-image.sh <network> <brand> <tag> [<registry>]

# Examples
./infra/keycloak/build-theme-image.sh blue_dot upsdm v1
./infra/keycloak/build-theme-image.sh orange_dot onetac v1 registry.your.co

# Dry run (prints resolved env_file + image tag, no docker build)
DRY_RUN=1 ./infra/keycloak/build-theme-image.sh blue_dot upsdm v1
```

---

## Adding a new brand

1. **Copy the network config folder** into a brand subfolder:

   ```bash
   cp -a config/<network>/ config/<network>/<newbrand>/
   ```

2. **Set the logo slug** in `config/<network>/<newbrand>/keycloak.env`:

   ```
   BRAND_LOGO_SLUG=<slug>
   ```

3. **Repoint logo paths** in `config/<network>/<newbrand>/brand.json` — change every `/brand/<old-slug>/` to `/brand/<slug>/`.

4. **Add logo assets** in both locations:

   ```bash
   apps/web/public/brand/<slug>/          # logo.png, logo-light.png, etc.
   infra/keycloak/themes/otp/login/resources/img/brand/<slug>/
   ```

5. **For Kubernetes**, build the baked theme image:

   ```bash
   ./infra/keycloak/build-theme-image.sh <network> <newbrand> <tag> [<registry>]
   ```

6. **Deploy** with the two env vars set:

   ```bash
   AGGREGATOR_NETWORK=<network> AGGREGATOR_BRAND=<newbrand> make up
   ```

   The `make check-brand` preflight (run automatically by `make up`) validates that `config/<network>/<newbrand>/` exists before the stack starts. If the folder is missing it exits with an error.

---

## Preflight validation

`make check-brand` (and `make up` which calls it) verifies that when `AGGREGATOR_BRAND` is set the config folder exists:

```bash
make check-brand   # standalone check — no docker activity
make up            # runs check-brand then brings the stack up
```
