---
name: Epic
about: P-06 signal-stack package (SignalStackClient + REST impl)
title: "[EPIC] P-06 signal-stack package (SignalStackClient + REST impl)"
labels: ["type:epic", "phase:0", "area:backend", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
`packages/signal-stack` provides the `SignalStackClient` interface and a REST adapter for the Signals Stack (UBI backend). Every call into the Signals Stack flows through this package — no other code knows the transport.

## Scope
**In scope:** interface; REST adapter (`./rest`); typed models for org/member/profile; org lookup by email/phone; member list; profile read; bulk-create seeker/provider; retry/backoff + circuit breaker; `./testing` mock; own config (base URL, auth, endpoints, retry policy); contract tests against Prism-generated mock from OpenAPI.
**Out of scope:** Caching of results (lives in `cache` package; callers decide).

## Child features
- [ ] F-06.1 `SignalStackClient` interface + DTOs
- [ ] F-06.2 REST adapter scaffold (`./rest`)
- [ ] F-06.3 Org lookup by email/phone
- [ ] F-06.4 Member list by aggregator
- [ ] F-06.5 Profile read
- [ ] F-06.6 Bulk-create seeker/provider
- [ ] F-06.7 Retry/backoff + circuit breaker
- [ ] F-06.8 Contract tests (Prism mock)
- [ ] F-06.9 Source-mode attribution support (`needs:upstream-confirmation`)

## Success criteria
- All endpoint paths come from config; zero hardcoded URLs
- Contract tests run against the published OpenAPI spec in CI
- Failure modes surfaced as typed `UpstreamError` subclasses

## Dependencies
- **Platform:** P-01, P-02, P-03, P-13
- **External:** Signals Stack team confirmation on source-mode attribution

## Open questions
- Do we generate the client from OpenAPI or hand-write? Recommend generate (openapi-typescript) + wrap.

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:backend`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
