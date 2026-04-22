# `@aggregator-dpg/schema-service`

Zod schemas and TypeScript types for the domain YAML files in `config/`. Each schema is auto-discovered by `config-loader` at boot via the `./config` subpath export convention.

## Subpath exports

| Subpath        | Contents                                                      |
| -------------- | ------------------------------------------------------------- |
| `./config`     | `ProfilesConfigSchema` — validates `config/profiles.yaml`     |
| `./entities`   | `EntitiesConfigSchema` — validates `config/entities.yaml`     |
| `./onboarding` | `OnboardingConfigSchema` — validates `config/onboarding.yaml` |
| `./features`   | `FeaturesConfigSchema` — validates `config/features.yaml`     |

## Usage

```typescript
import { FsConfigService } from '@aggregator-dpg/config-loader/fs';
import type { FeaturesConfig } from '@aggregator-dpg/schema-service/features';

const config = new FsConfigService();
await config.load('production');

const features = config.slice<FeaturesConfig>('features');
if (features.flags.bulkOnboarding) {
  // enable bulk CSV onboarding path
}
```

## Further reading

See [docs/config.md](../../docs/config.md) for the full precedence guide, secrets rules, hot-reload, and how to add a new config key.
