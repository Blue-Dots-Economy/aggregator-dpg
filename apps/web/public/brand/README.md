# Brand assets (logos & favicons) — authoring home

**aggregator-dpg is the source of truth for per-network logos.** Assets are
authored here and consumed by three places, which must be kept in sync:

| Consumer                        | Location                                                         |
| ------------------------------- | ---------------------------------------------------------------- |
| Aggregator web portal (Next.js) | `apps/web/public/brand/<network>/` (this folder)                 |
| Keycloak login theme            | `infra/keycloak/themes/otp/login/resources/img/brand/<network>/` |
| signals-ui (downstream copy)    | `Signals-DPG` → `apps/ui/public/brand/<network>/`                |

Folders are named by the **kebab-case** network id (`blue_dot` → `blue-dot/`).

## The mapping: `config/<network>/brand.json`

Each network's logo variants are declared in `config/<network>/brand.json` under
the `logo` block — variant key → asset path:

```json
{
  "default": "/brand/<network>/logo.png",
  "light": "/brand/<network>/logo-light.png",
  "withStrapline": "/brand/<network>/logo-with-strapline.png",
  "withStraplineLight": "/brand/<network>/logo-with-strapline-light.png",
  "onBrand": "/brand/<network>/logo-on-brand.png"
}
```

The web portal resolves logos through this `brand.json` (flexible mapping — a key
may point at any file). **signals-ui uses the same variant keys but via fixed
filenames** (`logo.png`, `logo-light.png`, …), so keep the on-disk filenames
matching the keys to stay portable across both.

## Variant set

| Key                  | Use                              | Background                 |
| -------------------- | -------------------------------- | -------------------------- |
| `default`            | Primary colour logo              | light                      |
| `light`              | Light/white version              | **dark** theme & dark hero |
| `withStrapline`      | Adds the "Seeded by …" strapline | light                      |
| `withStraplineLight` | Strapline version                | dark                       |
| `onBrand`            | Tuned for the brand-colour hero  | brand colour               |

`default` + `light` are required (light/dark theming auto-selects). Others
recommended.

## Format & sizing (summary)

- **PNG, 32-bit RGBA, transparent background.** No SVG (consumers map to `.png`). Keep < ~150 KB.
- Horizontal wordmark/lockup: ~5:1 (~900–1200 px wide). Compact/square mark: ~512 px long edge.
- Logos render by height (28–80 px on screen) → ship 2–3× for retina; trim transparent padding tight.
- **Favicon:** square PNG ≥ 180×180 (`favicon.png`) only for square-mark networks; wordmark networks auto-generate a dot-mark downstream.

> Full rendering details (display heights, the `isSquareishMark` /
> `NETWORKS_WITH_FAVICON_PNG` code flags a new network needs) live in the
> canonical spec: **Signals-DPG `apps/ui/public/brand/README.md`**.

## Adding / updating a network logo

1. Add/optimise the PNGs in **`apps/web/public/brand/<network>/`**.
2. Update **`config/<network>/brand.json`** `logo` keys to point at them.
3. Copy the PNGs to the **Keycloak theme** (`infra/keycloak/.../img/brand/<network>/`).
4. Sync the PNGs into **signals-ui** (`Signals-DPG/apps/ui/public/brand/<network>/`),
   keeping the fixed filenames.
