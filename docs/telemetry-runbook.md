# Telemetry On-Call Runbook

This document covers operational incident response for the OpenTelemetry
pipeline added in the Phase 0 – Phase 4 implementation (plan at
`docs/superpowers/plans/2026-05-25-telemetry-implementation.md`).

## Kill switch

If OTel itself is causing a production incident (Collector loop, SDK memory
leak, exporter regression), disable the SDK without a rebuild:

```bash
kubectl set env deploy/aggregator-api OTEL_SDK_DISABLED=true -n prod
kubectl rollout restart deploy/aggregator-api -n prod

# Repeat for worker, web, observability-svc as needed.
```

This stops ALL OTLP traffic immediately. pino still logs to stdout (so
container logs still work). No code changes required.

To re-enable: set `OTEL_SDK_DISABLED=false` and restart.

## Alert: OtelDroppedSpans

Fires when `otel.dropped_spans_total > 0` for 5 minutes.

**Triage:**

1. Check Collector pod logs for `memory_limiter` warnings:
   ```
   kubectl logs deploy/aggregator-dpg-otel-collector -n observability | grep memory_limiter
   ```
2. Check Collector pod CPU / memory:
   ```
   kubectl top pod -n observability | grep otel-collector
   ```
3. If the Collector is healthy, the app's BSP queue saturated. Increase
   `OTEL_BSP_MAX_QUEUE_SIZE` from the default 2048 in the affected service's
   Helm values, redeploy.
4. If the Collector is overloaded, scale it up (more replicas) or increase
   its memory limit. The dev config uses 400 MiB; prod uses 512 MiB.

## Alert: TelemetryTracesBudgetAt80 / TelemetryLogsBudgetAt80

Fires when traces > 40 GB/day (80% of 50 GB budget) or logs > 80 GB/day
(80% of 100 GB budget). See design §6.4.

**Triage:**

1. Identify the top source:
   - Traces: `topk(5, sum by (service_name) (rate(otelcol_exporter_sent_spans[5m])))`
   - Logs: `topk(5, sum by (service_name) (rate(otelcol_exporter_sent_log_records[5m])))`
2. If a service is misbehaving (debug log loop, span fan-out bug), turn its
   `OTEL_SAMPLE_RATE` down via Helm, redeploy.
3. If the volume is legitimate growth, raise the budget (and inform the
   platform team that costs are scaling). The §6.4 numbers are tuned for
   100 RPS; at higher RPS the budget should scale linearly.

## Outcome events failing

The api/worker emit outcomes via fire-and-forget POST to observability-svc.
If observability-svc returns 401 (HMAC mismatch) or 5xx, the producer
silently swallows the error.

**Symptoms:**

- Business KPIs (`aggregator_participant_registered_total` etc.) stop
  incrementing while the underlying business activity continues.
- observability-svc pods show 401s in their access logs:
  ```
  kubectl logs deploy/aggregator-dpg-observability-svc -n prod | grep '"statusCode":401'
  ```

**Triage:**

1. Verify the HMAC secret matches between producer and receiver:
   ```
   kubectl get secret aggregator-obs-secrets -n prod -o yaml
   ```
   Check the JSON has both `svc-api` and `svc-worker` keys, and each
   matches what the api/worker have in their env (also from the same
   Secret).
2. If observability-svc is returning 5xx, check its Redis dependency:
   ```
   kubectl exec deploy/aggregator-dpg-observability-svc -n prod -- nc -z redis 6379
   ```
3. On Redis outage, observability-svc fails open — it RECORDS the event and
   pages via `observability.outcome.dedup_unavailable_total`. Losing dedup is
   preferable to losing the event.

## Alert: ApiAvailabilityFastBurn / ApiAvailabilitySlowBurn

Standard SLO burn-rate alerts targeting 99.5% availability (design §9).

**Fast burn (5 min, 14.4x):** Pages immediately. Investigate the api 5xx
rate, downstream dependencies (DB, Redis, SignalStack). Use Jaeger to find
exemplar error traces.

**Slow burn (30 min, 6x):** Tickets the team. Suggests a steady-state
degradation rather than an acute incident. Often a downstream upstream
slowdown.

## Phased rollback

If the entire telemetry rollout needs to be undone:

1. Disable SDK in all services:
   ```
   helm upgrade aggregator-dpg helm/aggregator-dpg \
     --reuse-values \
     --set api.telemetry.enabled=false \
     --set worker.telemetry.enabled=false \
     --set web.telemetry.enabled=false
   ```
2. Confirm OTLP traffic stops (Collector pod logs show no incoming spans).
3. Investigate at leisure. Re-enable per service when fixed.
