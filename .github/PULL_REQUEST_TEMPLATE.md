## Summary

<!-- What does this PR do and why? -->

## Type of change

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor
- [ ] Docs / config

## Checklist

- [ ] `pnpm -w lint` passes
- [ ] `pnpm -w typecheck` passes
- [ ] `pnpm -w test` passes
- [ ] `pnpm dep-check` passes (no import boundary violations)

### If this PR adds or modifies `src/interface.ts` — [interface conventions](../docs/conventions/interfaces.md)

- [ ] Abstract class used (not TS `interface` or `type`)
- [ ] Every method is `abstract` — no default implementations
- [ ] All methods return `Result<T, BaseError>` (not bare throws)
- [ ] Zod schemas follow naming convention (`<Entity>Schema`, inferred type exported)
- [ ] DTOs extend shared primitives (`Filter`, `Paginated<T>`, `Timestamps`) where applicable
- [ ] Only `shared-primitives`, `zod`, `node:*` imported into interface file
- [ ] In-memory fake and testing fake updated to match any signature changes

### If this PR adds or modifies `src/testing/` — [testing conventions](../docs/conventions/testing.md)

- [ ] `ServiceFake` extends the in-memory implementation
- [ ] `seed()` helper covers all entity types the fake manages
- [ ] No real API calls or network access in tests
