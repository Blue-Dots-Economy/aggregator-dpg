# `@aggregator-dpg/config-loader`

Discovers per-package `config.defaults.yaml` files, merges them with `config/env/<env>.yaml` overrides, interpolates `${ENV_VAR}` references, validates the composite with Zod, and exposes typed config slices to every service.

## Subpath exports

| Subpath       | Contents                                                                            |
| ------------- | ----------------------------------------------------------------------------------- |
| `./interface` | `ConfigServiceBase` abstract class + types (`Env`, `ConfigSlice<S>`, `Unsubscribe`) |
| `./fs`        | `FsConfigService` — reads YAML from disk                                            |
| `./testing`   | `ConfigServiceFake` — in-memory fake for unit tests                                 |

## Usage

```typescript
// Boot (apps/api/src/index.ts)
import { FsConfigService } from '@aggregator-dpg/config-loader/fs';

const config = new FsConfigService();
await config.load('production'); // throws ConfigError on invalid config

const baseUrl = config.require<string>('signalStack.baseUrl');
const timeout = config.get<number>('signalStack.timeoutMs') ?? 5000;
```

```typescript
// In tests
import { ConfigServiceFake } from '@aggregator-dpg/config-loader/testing';

const config = new ConfigServiceFake({ signalStack: { baseUrl: 'http://localhost' } });
await config.load('test');
config.require<string>('signalStack.baseUrl'); // 'http://localhost'
```

## Config file conventions

- `packages/<name>/config.defaults.yaml` — default values, checked into repo; loaded after exported `configDefaults`
- `packages/<name>/src/config.schema.ts` — Zod schema validating the slice
- `config/env/{development,staging,production}.yaml` — per-env overrides (root of repo)

Per-package schema discovery and env-var interpolation (`${VAR}`) are implemented in F-03.2–F-03.4.

## Further reading

See [docs/config.md](../../docs/config.md) for the full precedence guide, secrets rules, hot-reload, and how to add a new config key.
