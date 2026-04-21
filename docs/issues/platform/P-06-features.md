# P-06 signal-stack package — features

---

## F-06.1 `SignalStackClient` interface + DTOs

**AC**
- [ ] `packages/signal-stack/src/interface.ts`: abstract class with methods `findOrgByEmail`, `findOrgByPhone`, `listMembers`, `getProfile`, `bulkCreateSeekers`, `bulkCreateProviders`
- [ ] DTOs typed from the Signals Stack OpenAPI (or hand-modelled if OpenAPI unavailable)
- [ ] All methods return `Result<T, UpstreamError>`

**Tasks**
- [ ] T-06.1.1 Interface + DTOs
- [ ] T-06.1.2 Result typing

---

## F-06.2 REST adapter scaffold (`./rest`)

**AC**
- [ ] HTTP client (undici) with timeout + retry wrapper
- [ ] Base URL, auth header, per-endpoint paths from config
- [ ] All requests emit a trace span with `upstream.system = "signal-stack"`

**Tasks**
- [ ] T-06.2.1 HTTP client wrapper
- [ ] T-06.2.2 Config wiring
- [ ] T-06.2.3 Tracing

---

## F-06.3 Org lookup by email/phone

**AC**
- [ ] Implements `findOrgByEmail` / `findOrgByPhone`
- [ ] Returns `None` (Result.err variant) on 404 rather than throwing
- [ ] Cached via `CacheService` (TTL from config; default 60 s)

**Tasks**
- [ ] T-06.3.1 Endpoint impl
- [ ] T-06.3.2 Caching layer

---

## F-06.4 Member list by aggregator

**AC**
- [ ] Paginated; cursor passed through from upstream
- [ ] Supports filter by registration mode (if upstream supports; else client-side filter)

**Tasks**
- [ ] T-06.4.1 Endpoint impl
- [ ] T-06.4.2 Pagination DTO mapping

---

## F-06.5 Profile read

**AC**
- [ ] `getProfile(userId)` returns the seeker/provider profile metadata + timestamps
- [ ] Field set matches README §3.1 `profile` table

**Tasks**
- [ ] T-06.5.1 Endpoint impl

---

## F-06.6 Bulk-create seeker/provider

**AC**
- [ ] `bulkCreateSeekers(rows, aggregatorId, mode)` and `bulkCreateProviders(rows, aggregatorId, mode)`
- [ ] Returns per-row `Result` preserving row index
- [ ] Sends `aggregator_id` and `source_mode` as per upstream contract

**Tasks**
- [ ] T-06.6.1 Seeker bulk-create
- [ ] T-06.6.2 Provider bulk-create
- [ ] T-06.6.3 Per-row error mapping

---

## F-06.7 Retry/backoff + circuit breaker

**AC**
- [ ] Retries on 5xx + transient errors (3 attempts, exponential jitter)
- [ ] Circuit breaker opens on > 50% failure rate over 30 s window
- [ ] Breaker state exported as a metric

**Tasks**
- [ ] T-06.7.1 Retry policy
- [ ] T-06.7.2 Circuit breaker
- [ ] T-06.7.3 Metrics

---

## F-06.8 Contract tests (Prism mock)

**AC**
- [ ] Prism server stood up from OpenAPI (or hand-crafted stub) in CI
- [ ] Contract test covers every interface method
- [ ] Test suite fails if adapter drifts from the contract

**Tasks**
- [ ] T-06.8.1 Prism CI job
- [ ] T-06.8.2 Contract test suite

---

## F-06.9 Source-mode attribution support

Labels: `needs:upstream-confirmation`

**AC**
- [ ] Confirms (or documents gap) that Signals Stack accepts `source_mode` per registration
- [ ] If gap: open a tracked issue upstream; adapter sends the field anyway in case it lands
- [ ] Aggregator behaviour degrades gracefully if upstream doesn't echo the attribution (mode-wise counts from SPS will still try — see SPS stub)

**Tasks**
- [ ] T-06.9.1 Upstream confirmation ticket
- [ ] T-06.9.2 Adapter sends + tolerates missing echo
