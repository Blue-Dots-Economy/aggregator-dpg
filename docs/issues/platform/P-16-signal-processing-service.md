---
name: Epic
about: P-16 Signal Processing Service — contract stub (external/deferred)
title: "[EPIC] P-16 Signal Processing Service — contract stub (external/deferred)"
labels: ["type:epic", "phase:post-mvp", "area:sps", "priority:p2", "needs:upstream-confirmation"]
milestone: "Post-MVP Backlog"
---

## Summary
**This epic is an out-of-scope stub.** Per README §5.2, the Signal Processing Service is "out of scope in current implementation" — it is an independent computation layer built and operated outside the Aggregator DPG. The Aggregator DPG only **consumes** SPS via the `SignalProcessingClient` (P-08); the service itself, its ingestion, its computation of status rules, and its refresh cadence are the responsibility of the SPS team.

This stub exists only to capture:
1. The **read-API contract** the Aggregator DPG depends on.
2. **Open questions** the Aggregator team needs answered by whoever owns SPS.
3. A placeholder so the dependency is tracked visibly in the backlog.

## Out of scope for this repo
- Service scaffolding, Dockerfile, deployment
- Ingestion jobs from Signals Stack / Jobs Stack
- Materialisation store and refresh scheduler
- Status-rule computation (seeker + provider per README Appendix B)
- Profile completion-% materialisation
- Mode-wise registration counts
- Aggregator summary materialisation

None of the above land in this repository. If/when placement changes (PRD open item 4) and SPS is built here, a new epic replaces this stub.

## In scope for this stub (contract + mock only)
- [ ] S-16.1 Document the read-API contract the Aggregator DPG consumes (endpoint shapes, pagination, filter params, response DTOs) — authoritative source of truth for P-08
- [ ] S-16.2 Provide a local mock/fake (`signal-processing-client/testing`) that returns fixture data matching the contract, so Phase 2/3 can be built and tested without a real SPS
- [ ] S-16.3 Contract tests in the Aggregator repo that validate any SPS implementation satisfies the documented contract (run against the fake in CI; can be re-pointed at a real SPS in staging)

## Consumer-side references
- `P-08` signal-processing-client (the interface + HTTP adapter)
- `Φ2` Onboarding — depends on P-08, not on P-16
- `Φ3` My Blue Dots — depends on P-08, not on P-16

## Open questions (block SPS owners, not us)
- PRD open item 1: DPDP consent scope for SPS
- PRD open item 3: Signals Stack source-mode attribution
- PRD open item 4: SPS placement (standalone vs embedded in Signals Stack)
- PRD open item 6: compute model (Option A materialised vs Option B streaming)
- Cadence of refresh (README §5.2 recommends 5–15 min)

## Success criteria for this stub
- Read-API contract documented in this repo
- Fake impl ships with `signal-processing-client`
- No code in this repo depends on SPS being implemented

## Labels / milestone
- Labels: `type:epic`, `phase:post-mvp`, `area:sps`, `priority:p2`, `needs:upstream-confirmation`
- Milestone: `Post-MVP Backlog`
