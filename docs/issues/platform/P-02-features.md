# P-02 Shared Primitives & Interface Conventions — features

---

## F-02.1 `shared-primitives` package

**Story:** As a service author, I want a single place for cross-service types so I don't duplicate errors, IDs, or Result types.

**AC**
- [ ] `packages/shared-primitives` created with subpath exports `./errors`, `./ids`, `./result`, `./dto`
- [ ] Error hierarchy: `BaseError` → `UpstreamError`, `ConfigError`, `AuthError`, `ValidationError`, `DomainError` (each with `code`, `cause`, optional `details`)
- [ ] Branded IDs: `AggregatorId`, `UserId`, `OrgId`, `LinkId`, `BatchId`, `ExportId` (nominal types via `Brand<T, 'Name'>`)
- [ ] `Result<T, E>` with `ok` / `err` helpers + `match` + `.map` / `.flatMap`
- [ ] Base DTOs: `Paginated<T>`, `Cursor`, `Filter`, common timestamps
- [ ] Zero runtime deps beyond `zod`

**Tests:** unit tests for error serialisation, branded-ID type-level guard, `Result` ergonomics.

**Tasks**
- [ ] T-02.1.1 Package scaffold + subpath exports
- [ ] T-02.1.2 Error hierarchy + serialiser
- [ ] T-02.1.3 Branded IDs + constructors with validators
- [ ] T-02.1.4 `Result` + tests
- [ ] T-02.1.5 Base DTOs (`Paginated`, `Cursor`, `Filter`)

---

## F-02.2 Per-service package template

**Story:** As a service author, I want a ready-made package template so every service follows the same layout and exports.

**AC**
- [ ] A `packages/_template/` folder demonstrating: `src/interface.ts`, `src/<impl>/`, `src/testing/`, `src/config.schema.ts`, `config.defaults.yaml`, `package.json` with subpath exports
- [ ] `scripts/new-service.ts` copies the template and sets names
- [ ] Docs in `packages/_template/README.md` explain the convention

**Tasks**
- [ ] T-02.2.1 Scaffold template package
- [ ] T-02.2.2 `scripts/new-service.ts` (rename + init)
- [ ] T-02.2.3 Template README

---

## F-02.3 Dep-cruiser rule: `./interface` only imports `shared-primitives` + `zod`

**AC**
- [ ] `.dependency-cruiser.cjs` defines rule `no-heavy-deps-in-interface`
- [ ] CI runs `depcruise` and fails on violations
- [ ] Canary test: adding `pg` import to an `interface.ts` fails CI

**Tasks**
- [ ] T-02.3.1 depcruise config with rule
- [ ] T-02.3.2 CI job
- [ ] T-02.3.3 Canary fixture

---

## F-02.4 Dep-cruiser rule: no service imports another service's impl subpath

**AC**
- [ ] Rule `no-cross-service-impl-imports`
- [ ] Violations include file + line in CI output

**Tasks**
- [ ] T-02.4.1 Author rule
- [ ] T-02.4.2 Wire into CI matrix

---

## F-02.5 Interface authoring conventions doc

**AC**
- [ ] `docs/conventions/interfaces.md` covers: abstract class vs TS interface (rule: abstract class with pure virtual methods), Zod schema naming, DTO naming, error-return conventions (`Result<T, BaseError>` vs throw)
- [ ] Every service PR checklist references this doc

**Tasks**
- [ ] T-02.5.1 Author doc
- [ ] T-02.5.2 Link from PR template

---

## F-02.6 Testing-subpath conventions doc

**AC**
- [ ] `docs/conventions/testing.md` covers: in-memory fake vs mock (rule: fake preferred), required surface (all interface methods), test data builders
- [ ] Template package's `testing/` follows the doc

**Tasks**
- [ ] T-02.6.1 Author doc
- [ ] T-02.6.2 Align template package
