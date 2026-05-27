# Telemetry Rollout — Staging → Prod

This document describes the runtime cutover for switching telemetry on in
staging then prod, per design `docs/telemetry-design.md` §10.4 and the plan
at `docs/superpowers/plans/2026-05-25-telemetry-implementation.md` (Task 3.7).

## Pre-requisites

All these MUST be true before starting the staging cutover:

- [ ] `helm/aggregator-dpg/charts/otel-collector/` chart deployed in the cluster.
- [ ] Jaeger, Loki, Prometheus, Grafana already running (operator chart, or
      the dev compose stack mirrored to k8s).
- [ ] `aggregator_api_request_duration_ms_*` baseline p99 captured on the
      pre-OTel api so regression detection has a control.
- [ ] On-call runbook (see `docs/telemetry-runbook.md`, created in Task 5.1)
      has been read by whoever is driving the rollout.

## Staging — head sample 1.0

```bash
helm upgrade --install aggregator-dpg helm/aggregator-dpg \
  --namespace staging \
  --set api.telemetry.enabled=true \
  --set api.telemetry.otel.sampleRate=1.0 \
  --set worker.telemetry.enabled=true \
  --set worker.telemetry.otel.sampleRate=1.0 \
  --set web.telemetry.enabled=true \
  --set web.telemetry.otel.sampleRate=1.0
```

After the rollout:

1. Confirm pods restarted cleanly. `kubectl rollout status deploy/aggregator-api -n staging` etc.
2. Wait 5 minutes. Verify traces in Jaeger at `aggregator-api` service.
3. Compare `histogram_quantile(0.99, ...)` of `aggregator_api_request_duration_ms_bucket` against the pre-OTel baseline. Goal per design G2: <1ms p99 increase.
4. Bake for ONE WEEK in staging. Watch the SLO burn-rate alerts (`ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`) — they should stay quiet.

### Staging gate (move to prod only after)

- [ ] One full week of staging traffic with telemetry enabled.
- [ ] No p99 regression of more than 1ms (design G2).
- [ ] Trace stitching api → worker → SignalStack visible in Jaeger.
- [ ] No SLO alerts fired except as expected.
- [ ] Logs visible in Loki via Grafana Explore with `service_name="aggregator-api"`.

## Production — head sample 0.1, tail sampling on

```bash
helm upgrade --install aggregator-dpg helm/aggregator-dpg \
  --namespace prod \
  --set api.telemetry.enabled=true \
  --set api.telemetry.otel.sampleRate=0.1 \
  --set worker.telemetry.enabled=true \
  --set worker.telemetry.otel.sampleRate=0.1 \
  --set web.telemetry.enabled=true \
  --set web.telemetry.otel.sampleRate=0.1
```

Tail sampling is governed by the prod Collector config
(`infra/otel-collector/otelcol-config.prod.yaml`) and applies regardless of
the app-side sample rate. It always keeps errors + slow traces (≥2s) + the
flagged-route allowlist.

### Production gate

- [ ] TWO weeks of prod traffic with telemetry enabled.
- [ ] Cost ≤ 80% of §6.4 budget (`telemetry:traces_gb_per_day`,
      `telemetry:logs_gb_per_day` — see `TelemetryTracesBudgetAt80` /
      `TelemetryLogsBudgetAt80` alerts).
- [ ] SLO availability target (`api_availability_target: 0.995`) holding.
- [ ] On-call has not used the kill switch (`OTEL_SDK_DISABLED=true`).

## Rollback

If anything goes wrong:

```bash
kubectl set env deploy/aggregator-api OTEL_SDK_DISABLED=true -n <namespace>
kubectl rollout restart deploy/aggregator-api -n <namespace>
```

Apply to api, worker, web independently. pino continues to log to stdout; no
OTLP traffic. The Collector and backends can be left running — no effect.

To re-enable, set `OTEL_SDK_DISABLED=false` and restart.

## Phase 4 follow-on

After Phase 3 completes, Phase 4 deploys `observability-svc` and turns on
outcome events. See plan Task 4.1+.
