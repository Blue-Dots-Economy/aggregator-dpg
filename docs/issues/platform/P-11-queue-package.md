---
name: Epic
about: P-11 queue package (QueueService + BullMQ impl)
title: "[EPIC] P-11 queue package (QueueService + BullMQ impl)"
labels: ["type:epic", "phase:0", "area:backend", "priority:p1"]
milestone: "Phase 0 — Foundations"
---

## Summary
`packages/queue` provides `QueueService` for background work: bulk uploads, exports, retention purges, webhook processing. Ships a BullMQ impl on Redis; an in-memory impl for tests.

## Scope
**In scope:** interface (enqueue/process/schedule); `./bullmq` impl; worker entrypoints; DLQ; retry/backoff per job type; `./testing` synchronous impl; own config.
**Out of scope:** Cron-style recurring jobs for SPS refresh (lives in P-16).

## Child features
- [ ] F-11.1 `QueueService` interface + typed job registry
- [ ] F-11.2 BullMQ impl
- [ ] F-11.3 Worker entrypoints + graceful shutdown
- [ ] F-11.4 DLQ + retry policy

## Success criteria
- Each job type has explicit retry/backoff/DLQ policy declared with its registration
- Workers shut down gracefully on SIGTERM, draining in-flight jobs

## Dependencies
- **Platform:** P-01, P-02, P-03, P-12, P-13

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:backend`, `priority:p1`
- Milestone: `Phase 0 — Foundations`
