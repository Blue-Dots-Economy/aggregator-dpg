# Network configuration — deploying against any signalstack network

The aggregator is a generic platform. A single image runs against any
signalstack network (`blue_dot`, `purple_dot`, `yellow_dot`, future
networks) by swapping one YAML file. There is no hardcoded domain id,
item type, field name, or brand string in business logic.

## How it works

```
                  config/aggregator.config.yaml
                            │
                            ▼
                  packages/network-config
                            │
                  ┌─────────┴─────────┐
                  ▼                   ▼
        signalstack network.json      brand + identity overrides
        (fetched from GitHub raw)     (read from the YAML)
                  │                   │
                  └─────────┬─────────┘
                            ▼
                  ResolvedNetworkConfig (singleton)
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   api routes           worker jobs        web `useAggregatorConfig`
   (item_type,          (identity          (brand, tab labels,
   identity fields)     selectors,         url slug)
                        CSV array
                        delimiter)
```

## Per-deployment steps

1. **Edit `config/aggregator.config.yaml`**:

   ```yaml
   aggregator:
     name: BBMP
     network:
       source: https://raw.githubusercontent.com/Blue-Dots-Economy/Signals-DPG/refs/tags/v1.2.0/examples/schemas/purple_dot/network.json
     brand:
       short_name: Purple Dots
       long_name: Purple Dot Aggregator Portal
       url_slug: purple-dots
       primary_color: '#7C3AED'
   ```

2. **Set signalstack secrets in `.env`** (one-time per deploy):

   ```bash
   SIGNALSTACK_BASE_URL=http://host.docker.internal:2742
   SIGNALSTACK_ADMIN_KEY=sk_signals_...
   SIGNALSTACK_ACTING_ORG_ID=org_...
   ```

3. **Bring up the stack**:

   ```bash
   docker compose up -d --build
   ```

The api + worker mount `config/aggregator.config.yaml` from the host
at `/app/config/aggregator.config.yaml`. Both processes fetch the
`network.source` URL on first request and cache the resolved config
for the process lifetime. The fetched signalstack `network.json` is
written to `config/.cache/` as a last-known-good copy so a transient
GitHub outage on restart doesn't bring the aggregator down.

## What the YAML controls

| Field                                                            | Why                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `aggregator.name`                                                | Org display name (emails, KC realm).                                                                                                                                      |
| `network.source`                                                 | Upstream signalstack network.json. Pin to a tag in prod.                                                                                                                  |
| `network.field_overrides.{domain}.{name,phone,email}`            | Override the heuristic sniffer when a schema's field naming resists detection. Optional.                                                                                  |
| `network.csv_array_delimiter`                                    | Cell delimiter for `type: array` schema fields in bulk CSV uploads. Default `                                                                                             | `.  |
| `brand.short_name`                                               | Sidebar header + "My X" link label.                                                                                                                                       |
| `brand.long_name`                                                | Page title, browser tab.                                                                                                                                                  |
| `brand.tagline`                                                  | Topbar subtitle on the dashboard.                                                                                                                                         |
| `brand.url_slug`                                                 | URL slug — kebab-case alphanumeric. (Route renaming is a separate follow-up.)                                                                                             |
| `brand.primary_color`, `accent_color`, `logo_url`, `favicon_url` | UI surface — used by the web app's `useAggregatorConfig` hook.                                                                                                            |
| `domain_labels.{domain}.{singular,plural,tab_label}`             | UI overrides per domain. Optional — defaults derived from network.json.                                                                                                   |
| `onboarding.presume_consent`                                     | When `true`, every signalstack onboard call sends `terms_accepted=privacy_accepted=true` based on aggregator-level consent. Set false to require per-row consent capture. |
| `onboarding.bulk_max_rows`                                       | Hard ceiling on bulk CSV row count.                                                                                                                                       |
| `admin_emails`                                                   | Recipients of the admin-review email at aggregator registration.                                                                                                          |

## Heuristic field sniffer

When `network.field_overrides` is absent for a domain, the sniffer
derives the identity selectors from the JSON Schema:

- **phone**: schema has `format: tel`, or `pattern` like `^[0-9]{10}$`
  or starts with `\+`, or the field name contains `phone` / `mobile`.
- **email**: `format: email`, or field name contains `email`.
- **name**: field named exactly `name`, ends in `_name` (snake_case)
  or `Name` (camelCase).

Verified against:

- **blue_dot**: seeker (`name` / `phone` / `email`) + provider
  (`jobProviderName` / `hiringManagerPhoneNumber` / `hiringManagerEmail`)
- **purple_dot**: seeker (`beneficiary_name` / `mobile_number` /
  `email`) + provider (`contact_name` / `contact_phone` /
  `contact_email`)

If your schema breaks the sniffer, fill in `field_overrides`.

## Failure modes

| Condition                                                    | Behavior                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `aggregator.config.yaml` missing                             | api/worker boot fails loudly with `CONFIG_FILE_MISSING`.                                                         |
| YAML schema validation fails                                 | Boot fails with `CONFIG_PARSE_FAILED`.                                                                           |
| network.json unreachable + no cache                          | `NETWORK_FETCH_FAILED` — falls through to next request retry, OR if startup-blocking, aggregator fails to serve. |
| network.json unreachable + cache present                     | Loads from cache; logs a `cache_recovery` warning.                                                               |
| Field sniffer can't identify a domain's name / phone / email | `DOMAIN_RESOLUTION_FAILED` — fix by adding `field_overrides.{domain}` to the YAML.                               |

## Test fixtures

Use `@aggregator-dpg/network-config/testing`:

```ts
import { buildBlueDotConfig, buildPurpleDotConfig } from '@aggregator-dpg/network-config/testing';
import { _setNetworkConfig } from '../services/network-config.js';

beforeEach(() => {
  _setNetworkConfig(buildPurpleDotConfig());
});
```

Both builders return deterministic `ResolvedNetworkConfig` objects
that mirror what the live loader would produce.

## Open follow-ups (not blocking current networks)

- **DB `participant_type` enum** still ships as `text` with an enum
  check constraint pinned to `{seeker, provider}`. Yellow_dot's
  `learner`/`tutor` domain ids require migration 0011 to drop the
  enum constraint or extend it with the new values.
- **URL slug routing**: `/blue-dots/*` paths remain literal. Switch
  to `/${brand.url_slug}/*` in a follow-up PR if operators want the
  URL to reflect the network. Brand surfaces (sidebar, topbar, page
  title) already read from the slug.
- **`RoleTypeSchema`** in shared-primitives is still pinned to
  `enum(['seeker', 'provider'])`. New call sites should use
  `DomainIdSchema` (open string). Existing sites will migrate as
  yellow_dot deployments roll out.
