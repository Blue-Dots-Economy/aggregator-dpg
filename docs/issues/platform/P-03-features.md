# P-03 config-loader (ConfigService) — features

---

## F-03.1 `ConfigService` interface + FS loader impl

**AC**
- [ ] Interface in `packages/config-loader/src/interface.ts`: `load(env)`, `get<T>(path)`, `require<T>(path)`, `reload()`, `onChange(cb)`
- [ ] FS impl at `./fs` reads from `<package>/config.defaults.yaml` + `config/env/<env>.yaml`
- [ ] `./testing` impl accepts an in-memory object
- [ ] Typed via `ConfigSlice<Schema>` using Zod infer

**Tasks**
- [ ] T-03.1.1 Interface + types
- [ ] T-03.1.2 FS loader
- [ ] T-03.1.3 Testing impl

---

## F-03.2 Per-package schema discovery

**AC**
- [ ] Convention: each package exports `configSchema` and `configKey` from its package root
- [ ] Loader walks `packages/*/package.json`, imports the package, registers its schema
- [ ] Missing / duplicate `configKey` fails boot with a clear error

**Tasks**
- [ ] T-03.2.1 Discovery walker
- [ ] T-03.2.2 Duplicate/missing key diagnostics

---

## F-03.3 Env-YAML merge (`config/env/<env>.yaml`)

**AC**
- [ ] Env file deep-merges over per-package defaults
- [ ] `NODE_ENV` drives which env file is selected; overrideable by `CONFIG_ENV`
- [ ] Unknown keys in env file fail Zod validation (strict mode)

**Tasks**
- [ ] T-03.3.1 Deep merge utility
- [ ] T-03.3.2 Env selection logic

---

## F-03.4 Env-var `${VAR}` interpolation

**AC**
- [ ] String values matching `${VAR}` or `${VAR:-default}` interpolate from `process.env`
- [ ] Missing `${VAR}` with no default fails boot
- [ ] Interpolation happens before Zod validation

**Tasks**
- [ ] T-03.4.1 Interpolator
- [ ] T-03.4.2 Tests for missing/default cases

---

## F-03.5 Composite Zod validation + typed slice accessors

**AC**
- [ ] A composite `Record<configKey, packageSchema>` Zod schema is built at boot
- [ ] Validation errors aggregate and report every offender (not just the first)
- [ ] `config.slice<Db>()` returns the validated, typed slice for the `db` package

**Tasks**
- [ ] T-03.5.1 Composite builder
- [ ] T-03.5.2 Error aggregator
- [ ] T-03.5.3 Slice accessor API

---

## F-03.6 `profiles.yaml`

**AC**
- [ ] `config/profiles.yaml` authored with Who-I-Am / What-I-Have / What-I-Want sections
- [ ] Each field: `name`, `type`, `required`, optional `options`, `group`
- [ ] Schema validated by `schema-service`'s Zod schema
- [ ] Completion-% threshold field (`completeness.threshold`, default 0.75) configurable here

**Tasks**
- [ ] T-03.6.1 YAML authored from PRD Profile schema
- [ ] T-03.6.2 Zod schema in `schema-service`

---

## F-03.7 `entities.yaml`

**AC**
- [ ] Declares entity types (`seeker`, `provider`) with field bindings to profile sections
- [ ] Room for future entity types without code changes

**Tasks**
- [ ] T-03.7.1 YAML authored
- [ ] T-03.7.2 Zod schema + consumer hooks

---

## F-03.8 `onboarding.yaml`

**AC**
- [ ] Keys: `modes.bulk.enabled`, `modes.qr.enabled`, `modes.link.enabled`, CSV template refs, link TTL, QR size
- [ ] Changing a toggle hides/shows the corresponding UI path and disables the endpoint

**Tasks**
- [ ] T-03.8.1 YAML authored
- [ ] T-03.8.2 Zod schema

---

## F-03.9 `features.yaml`

**AC**
- [ ] Keys: feature flags (beta gates, post-MVP staging), default locale, available locales
- [ ] Consumed by `apps/api` + `apps/web`

**Tasks**
- [ ] T-03.9.1 YAML authored
- [ ] T-03.9.2 Consumer hook + React context wrapper in web

---

## F-03.10 Hot-reload (dev) vs boot-only (prod)

**AC**
- [ ] `CONFIG_WATCH=1` enables fs-watch + `onChange()` callbacks in dev
- [ ] In prod, `CONFIG_WATCH` is ignored; changes require restart
- [ ] Reload preserves in-flight requests (no partial-state reads)

**Tasks**
- [ ] T-03.10.1 fs-watch + debounce
- [ ] T-03.10.2 Dev-only gate with clear log

---

## F-03.11 Precedence + overrides docs

**AC**
- [ ] `docs/config.md` explains precedence (defaults → env YAML → env vars), env selection, secrets rules, and how to add a new key
- [ ] Linked from every service's README

**Tasks**
- [ ] T-03.11.1 Author doc
- [ ] T-03.11.2 Lint rule: every service README must link to `docs/config.md`
