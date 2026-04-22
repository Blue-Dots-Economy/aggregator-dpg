# `packages/_template` — Service Package Convention

This directory is the canonical layout every aggregator-dpg service package must follow.
Do not add real business logic here. Copy it with the scaffold script instead.

## Scaffold a new package

```bash
pnpm new-service <name>
# e.g. pnpm new-service signal-stack
```

Creates `packages/<name>/` with all template files substituted. Aborts if the target already exists.

## Package layout

```
packages/<name>/
├── config.defaults.yaml        # Default config values (loaded by config-loader)
├── package.json                # Subpath exports: ./interface and ./testing
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── config.schema.ts        # Zod schema for this package's config
    ├── interface.ts            # Abstract base class + domain types (./interface subpath)
    ├── in-memory/
    │   └── index.ts            # In-memory implementation (local dev + used by testing fake)
    ├── testing/
    │   └── index.ts            # ServiceFake with seed helpers (./testing subpath)
    └── __tests__/
        └── service.test.ts     # Unit tests using ServiceFake — no real API calls
```

## The three rules

### 1. Abstract class before any concrete implementation

`src/interface.ts` must define an abstract class. Every concrete implementation extends it and implements every method with the exact same signature. External packages import **only** from the `./interface` subpath.

```typescript
// packages/<name>/src/interface.ts
export abstract class ServiceBase {
  abstract findById(id: string): Promise<Result<MyEntity, BaseError>>;
  abstract save(entity: Omit<MyEntity, 'createdAt'>): Promise<Result<MyEntity, BaseError>>;
  abstract delete(id: string): Promise<Result<void, BaseError>>;
}

// another-package/src/something.ts — correct
import type { ServiceBase } from '@aggregator-dpg/<name>/interface';

// another-package/src/something.ts — wrong, never do this
import { InMemoryService } from '@aggregator-dpg/<name>/in-memory';
```

### 2. Fake over mock in tests

Every package ships a `ServiceFake` in the `./testing` subpath. Tests use the fake — not `vi.mock()`. The fake extends the in-memory implementation and adds `seed()` helpers for pre-populating state.

```typescript
import { ServiceFake } from '@aggregator-dpg/<name>/testing';

it('finds an item', async () => {
  const svc = new ServiceFake();
  svc.seed([{ id: 'x', name: 'X', createdAt: new Date() }]);
  const result = await svc.findById('x');
  expect(result.success).toBe(true);
});
```

### 3. Result over throw at service boundaries

All methods return `Result<T, BaseError>` from `@aggregator-dpg/shared-primitives/result`. Never throw from a service method — callers handle errors via `match()`, `.map()`, or `unwrap()`.

```typescript
import { match } from '@aggregator-dpg/shared-primitives/result';

const result = await svc.findById(id);
match(result, {
  onOk: (item) => console.log(item),
  onErr: (err) => logger.error({ operation: 'findById', status: 'failure', error: err.message }),
});
```

## Config convention

- `config.defaults.yaml` — default values checked into the repo
- `src/config.schema.ts` — Zod schema that validates the loaded config
- Per-environment overrides go in `config/env/{dev,staging,prod}.yaml` (root of repo)
- Read config **once** at startup via `@aggregator-dpg/config-loader` — never re-read inside request paths
