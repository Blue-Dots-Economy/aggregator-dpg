---
name: Epic
about: P-13 observability package
title: "[EPIC] P-13 observability package"
labels: ["type:epic", "phase:0", "area:observability", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
`packages/observability` provides `Logger`, `Metrics`, and `Tracer` interfaces plus a concrete impl using pino (logs), Prometheus (metrics), and OpenTelemetry (traces). Also exposes a request-ID middleware, HTTP histogram, and an audit-log writer used by DPDP controls.

## Scope
**In scope:** `Logger`/`Metrics`/`Tracer` interfaces; pino-OTel-Prom impl; context propagation; request ID; HTTP histogram; audit log writer; alert rule definitions (Grafana/Alertmanager); dashboards JSON; own config.
**Out of scope:** Dashboards for SPS internals (P-16 emits its own).

## Child features
- [ ] F-13.1 `Logger` + context propagation (pino)
- [ ] F-13.2 Request-ID middleware
- [ ] F-13.3 `Metrics` (Prometheus) + HTTP histogram
- [ ] F-13.4 `Tracer` (OpenTelemetry) + upstream call spans
- [ ] F-13.5 Dashboards + alert rules (upstream 5xx, SPS refresh failures, OTP failures)
- [ ] F-13.6 Audit log writer (DPDP requirement)

## Success criteria
- Every HTTP request logs: `request_id`, `aggregator_id`, `user_id`, `route`, `latency_ms`, `status`
- Alerts fire for upstream 5xx > 2% over 5 min
- Audit log captures every participant-detail read and export

## Dependencies
- **Platform:** P-01, P-02, P-03

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:observability`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
