#!/usr/bin/env bash
#
# Phase 1 telemetry smoke test (run manually when the dev environment is up).
#
# Prerequisites:
#   1. Compose stack is up:
#        docker compose up -d otel-collector jaeger loki prometheus grafana \
#                            postgres redis
#   2. Database migrations have run (or RUN_MIGRATIONS_ON_BOOT=true on the api).
#   3. The api process is running with OTEL_SDK_DISABLED=false. E.g.:
#        pnpm --filter @aggregator-dpg/api dev
#
# What this script does:
#   - Hits /v1/health on the api so a trace is produced.
#   - Pings Jaeger, Prometheus, Loki, Grafana to confirm reachability.
#   - Prints the URLs to open for manual verification.

set -euo pipefail

API_URL="${API_URL:-http://localhost:4000}"
JAEGER_URL="${JAEGER_URL:-http://localhost:16686}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"
LOKI_URL="${LOKI_URL:-http://localhost:3100}"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3001}"

echo "→ Pinging api at $API_URL/v1/health"
curl -sf "$API_URL/v1/health" || { echo "✗ api not reachable"; exit 1; }
echo " ✓"

echo "→ Pinging Jaeger at $JAEGER_URL"
curl -sfI "$JAEGER_URL" > /dev/null && echo " ✓" || echo " ✗"

echo "→ Pinging Prometheus at $PROMETHEUS_URL/-/ready"
curl -sf "$PROMETHEUS_URL/-/ready" > /dev/null && echo " ✓" || echo " ✗"

echo "→ Pinging Loki at $LOKI_URL/ready"
curl -sf "$LOKI_URL/ready" > /dev/null && echo " ✓" || echo " ✗"

echo "→ Pinging Grafana at $GRAFANA_URL/api/health"
curl -sf "$GRAFANA_URL/api/health" > /dev/null && echo " ✓" || echo " ✗"

echo
echo "Open these to verify traces / metrics / logs:"
echo "  Jaeger:     $JAEGER_URL (service: aggregator-api)"
echo "  Prometheus: $PROMETHEUS_URL/graph?g0.expr=aggregator_api_requests_total"
echo "  Grafana:    $GRAFANA_URL/explore (datasource: Loki, query: {service_name=\"aggregator-api\"})"
echo
echo "✓ Phase 1 smoke test complete."

echo
echo "=== Phase 2 — Cross-process trace verification ==="
echo
echo "POST a bulk upload to produce a trace that spans api → worker → SignalStack:"
echo
echo "  curl -sf -X POST $API_URL/v1/onboard/bulk-uploads \\"
echo "    -H 'Authorization: Bearer <dev-jwt>' \\"
echo "    -F file=@/tmp/sample-2rows.csv"
echo
echo "Then open Jaeger:"
echo "  $JAEGER_URL/search?service=aggregator-api"
echo
echo "Look for a trace whose root is 'api.request POST /v1/onboard/bulk-uploads'."
echo "It should contain children:"
echo "  - queue.enqueue   (api side)"
echo "  - worker.bulk-file-process.process (worker)"
echo "  - one or more worker.bulk-row-process.process (worker)"
echo "  - worker.signalstack.onboard (worker)"
echo
echo "All under one trace_id. If the worker spans appear as a separate trace,"
echo "the producer-side addJobWithTrace or worker-side wrapWorker is not wired."
