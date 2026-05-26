# @aggregator-dpg/observability-svc

Outcome-event receiver. Producers (api, worker) post HMAC-signed business
events here; the service validates, dedupes via Redis, and increments
config-driven OTel metrics.

See `docs/telemetry-design.md` §4.4 and §12 for the design.
