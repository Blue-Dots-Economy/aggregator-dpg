# P-13 observability package — features

---

## F-13.1 `Logger` + context propagation (pino)

**AC**
- [ ] Interface: `Logger` with `debug/info/warn/error/fatal` + `child(bindings)`
- [ ] pino impl; JSON output in prod, pretty in dev (driven by config)
- [ ] AsyncLocalStorage-based context: every log line carries `request_id`, `aggregator_id`, `user_id`
- [ ] PII redaction (P-20.4) wired as a serializer

**Tasks**
- [ ] T-13.1.1 Interface
- [ ] T-13.1.2 pino impl + redaction
- [ ] T-13.1.3 AsyncLocalStorage context binding

---

## F-13.2 Request-ID middleware

**AC**
- [ ] Accepts inbound `x-request-id` if valid; else generates a ULID
- [ ] Propagates to upstream calls via header
- [ ] Logged on every request

**Tasks**
- [ ] T-13.2.1 Middleware
- [ ] T-13.2.2 Upstream propagation helper

---

## F-13.3 `Metrics` (Prometheus) + HTTP histogram

**AC**
- [ ] Interface with `counter`, `gauge`, `histogram`, `summary` factories
- [ ] Prom impl; `/metrics` endpoint mounted with basic-auth guard
- [ ] HTTP histogram labeled by route, method, status

**Tasks**
- [ ] T-13.3.1 Interface
- [ ] T-13.3.2 Prom impl + `/metrics`
- [ ] T-13.3.3 HTTP middleware

---

## F-13.4 `Tracer` (OpenTelemetry) + upstream call spans

**AC**
- [ ] Interface with `startSpan`, `withSpan(fn)`
- [ ] OTel impl; exporter endpoint from config
- [ ] All upstream HTTP calls (P-06, P-07, P-08) wrap in spans with `upstream.system` attribute

**Tasks**
- [ ] T-13.4.1 Interface
- [ ] T-13.4.2 OTel impl
- [ ] T-13.4.3 Upstream span helper

---

## F-13.5 Dashboards + alert rules

**AC**
- [ ] `ops/grafana/` contains JSON dashboards: API overview, upstream health, queue, cache
- [ ] `ops/alerts/` contains Prometheus rules: upstream 5xx > 2% over 5 min, OTP failure rate > 10% over 5 min, DLQ depth > 10, SPS freshness > 30 min
- [ ] README in `ops/` explains how to install

**Tasks**
- [ ] T-13.5.1 Grafana dashboards
- [ ] T-13.5.2 Prom alert rules
- [ ] T-13.5.3 Ops README

---

## F-13.6 Audit log writer (DPDP)

**AC**
- [ ] Interface `AuditLog.record({ actor, action, entity, entityId, payload })`
- [ ] Writes to `audit_log` table (P-04.4.6) via `DBService`
- [ ] Synchronous commit before HTTP response to any audited route
- [ ] Every participant-detail read and every export must call this

**Tasks**
- [ ] T-13.6.1 Interface + DB write
- [ ] T-13.6.2 Lint rule: routes marked `@audited` must call `AuditLog.record` before response
