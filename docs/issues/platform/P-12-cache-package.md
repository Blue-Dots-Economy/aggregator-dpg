---
name: Epic
about: P-12 cache package (CacheService + Redis impl)
title: "[EPIC] P-12 cache package (CacheService + Redis impl)"
labels: ["type:epic", "phase:0", "area:backend", "priority:p2"]
milestone: "Phase 0 — Foundations"
---

## Summary
`packages/cache` provides `CacheService` (get/set/del/ttl) with a Redis impl and an in-memory impl. Used by the Aggregator API for short-lived SPS result caching and rate-limit counters.

## Scope
**In scope:** interface; `./redis` impl; `./memory` impl; key-prefix + TTL conventions; own config.
**Out of scope:** Pub/sub (not needed in MVP).

## Child features
- [ ] F-12.1 `CacheService` interface
- [ ] F-12.2 Redis impl (`./redis`)
- [ ] F-12.3 Key schemes + TTL conventions documented

## Success criteria
- Every cache key namespaced by package + aggregator_id
- Miss ratio observable via metrics

## Dependencies
- **Platform:** P-01, P-02, P-03, P-13

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:backend`, `priority:p2`
- Milestone: `Phase 0 — Foundations`
