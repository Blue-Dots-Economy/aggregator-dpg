---
name: Epic
about: P-03 config-loader package (ConfigService)
title: "[EPIC] P-03 config-loader package (ConfigService)"
labels: ["type:epic", "phase:0", "area:config", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
Build the `config-loader` package that discovers each service package's `config.schema.ts` + `config.defaults.yaml`, merges with `config/env/<env>.yaml` overrides, interpolates env vars, validates the composite with Zod, and exposes typed config slices via the `ConfigService` interface.

## Scope
**In scope:**
- `ConfigService` interface + FS loader impl (+ testing fake)
- Per-package schema discovery mechanism
- Env-YAML merge (`config/env/{dev,staging,prod}.yaml`)
- `${VAR}` env interpolation
- Composite Zod validation + typed accessors
- Domain YAMLs: `profiles.yaml`, `entities.yaml`, `onboarding.yaml`, `features.yaml`
- Hot-reload (dev) vs boot-only (prod)
- Precedence/override documentation

**Out of scope:**
- Individual service config schemas (owned by each service's epic)
- Runtime (DB-backed) config editing (deferred)

## Child features
- [ ] F-03.1 `ConfigService` interface + FS loader impl
- [ ] F-03.2 Per-package schema discovery
- [ ] F-03.3 Env-YAML merge
- [ ] F-03.4 Env-var `${VAR}` interpolation
- [ ] F-03.5 Composite Zod validation + typed slice accessors
- [ ] F-03.6 `profiles.yaml`
- [ ] F-03.7 `entities.yaml`
- [ ] F-03.8 `onboarding.yaml`
- [ ] F-03.9 `features.yaml`
- [ ] F-03.10 Hot-reload (dev) vs boot-only (prod)
- [ ] F-03.11 Precedence + overrides docs

## Success criteria
- Boot fails loudly with a readable error naming the offending key on any invalid config
- Adding a new service package's config requires zero changes to `config-loader`
- `config/env/prod.yaml` can override any key from any package

## Dependencies
- **Platform epics:** P-01, P-02

## Open questions
- Should hot-reload live behind a dev-only flag or a separate impl subpath? Default to a flag on the FS loader.

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:config`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
