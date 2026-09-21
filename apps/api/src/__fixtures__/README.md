# Test fixtures

## `aggregator-forms.blue_dot.json`

A verbatim copy of the `blue_dot` bundle published in
[`bluedots-schemas`](https://github.com/Blue-Dots-Economy/bluedots-schemas).

This repo intentionally ships **no** form schemas since #640 — they are fetched
from `aggregator.network.forms_source` at boot. That leaves the test suite
without a form contract to exercise, and pointing tests at the network would
make them slow and flaky.

So this file exists **only** to pin `ResolvedNetworkConfig.forms` in tests, via
`_setNetworkConfig(buildBlueDotConfig({ forms: … }))`. Nothing in `src/` outside
a `*.test.ts` may import it; if production code ever reads it, the on-disk
fallback #640 removed has been reintroduced by the back door.

Refresh it by re-downloading the published bundle when the form changes.
