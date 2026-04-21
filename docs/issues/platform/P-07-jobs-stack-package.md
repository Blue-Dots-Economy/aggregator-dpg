---
name: Epic
about: P-07 jobs-stack package (JobsStackClient + REST impl)
title: "[EPIC] P-07 jobs-stack package (JobsStackClient + REST impl)"
labels: ["type:epic", "phase:0", "area:backend", "priority:p1"]
milestone: "Phase 0 — Foundations"
---

## Summary
`packages/jobs-stack` provides the `JobsStackClient` interface and a REST adapter for the Jobs Stack. Exposes postings, applications, and application statuses needed downstream by the Signal Processing Service.

## Scope
**In scope:** interface + DTOs; REST adapter; postings read; applications read; status mapping (open/shortlisted/rejected); retry/backoff; `./testing` mock; own config; contract tests.
**Out of scope:** Write endpoints (MVP is read-only for jobs data).

## Child features
- [ ] F-07.1 `JobsStackClient` interface + DTOs
- [ ] F-07.2 REST adapter scaffold
- [ ] F-07.3 Postings read
- [ ] F-07.4 Applications read
- [ ] F-07.5 Status mapping
- [ ] F-07.6 Retry/backoff
- [ ] F-07.7 Contract tests

## Success criteria
- Status labels match README §3.2 conventions exactly
- Zero hardcoded URLs; all endpoints from config

## Dependencies
- **Platform:** P-01, P-02, P-03, P-13

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:backend`, `priority:p1`
- Milestone: `Phase 0 — Foundations`
