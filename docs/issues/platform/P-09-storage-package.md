---
name: Epic
about: P-09 storage package (StorageService + S3/local impls)
title: "[EPIC] P-09 storage package (StorageService + S3/local impls)"
labels: ["type:epic", "phase:0", "area:backend", "priority:p1"]
milestone: "Phase 0 — Foundations"
---

## Summary
`packages/storage` provides `StorageService` for object storage of exports (CSV) and bulk upload artifacts. Ships an S3-compatible impl and a local-disk impl for dev/tests.

## Scope
**In scope:** interface (put/get/signedUrl/delete); `./s3` impl; `./local` impl; signed URL generation with configurable TTL; retention/purge scheduler hook; own config (bucket, region, TTL, retention days).
**Out of scope:** Encryption key management (relies on bucket defaults).

## Child features
- [ ] F-09.1 `StorageService` interface + local-disk dev impl
- [ ] F-09.2 S3/GCS impl (`./s3`)
- [ ] F-09.3 Signed URL generation + TTL
- [ ] F-09.4 Retention/purge job

## Success criteria
- Signed URLs default to ≤ 1 h TTL
- Retention default: 7 days

## Dependencies
- **Platform:** P-01, P-02, P-03, P-11 (purge runs on queue), P-13

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:backend`, `priority:p1`
- Milestone: `Phase 0 — Foundations`
