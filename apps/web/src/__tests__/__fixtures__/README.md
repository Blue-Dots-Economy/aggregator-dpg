# Test fixtures

Verbatim copies of bundles published in
[`bluedots-schemas`](https://github.com/Blue-Dots-Economy/bluedots-schemas).

Since #640 this repo ships no form schemas — they are fetched from
`forms_source` at boot. These copies exist so the suite can assert against the
_real_ published documents without a network call, which is what the tests they
replaced were doing when they read `config/schemas/aggregator/`.

`apps/api/src/__fixtures__/` holds the same `blue_dot` bundle for the API suite.
Two copies rather than a shared package: they are inert test data, and a shared
`./testing` export would have to be emitted through `dist` for both consumers.

Refresh by re-downloading when a form changes.
