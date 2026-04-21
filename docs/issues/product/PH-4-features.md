# Φ4 Phase 4 — Hardening — features

> Final MVP pass before beta: perf validation, DPDP controls finalisation, a11y audit, rollout wiring, load/chaos, runbooks.

---

## F4.1 Perf test suite + targets (README §7.5)

**Story:** As ops, I want a reproducible perf suite so regressions are caught before beta.

**AC**
- [ ] k6 (or artillery) scripts for the five targets:
  - Dashboard load (Blue Dots summary + first page) < 2.0 s p95, ≤ 10k participants
  - Participant list (50 rows) < 800 ms p95
  - Bulk upload 1,000 rows < 60 s E2E
  - Export 10k rows sync < 30 s
  - SPS freshness ≤ 15 min
- [ ] Suite runs in CI nightly against staging; report artefacted
- [ ] Thresholds fail the suite when breached

**Tests:** the suite itself; a canary regression breaks the nightly build.

**Tasks**
- [ ] T-4.1.1 k6 scripts per target
- [ ] T-4.1.2 Staging target env
- [ ] T-4.1.3 Nightly CI + artefact publish
- [ ] T-4.1.4 Slack/email alert on threshold breach

---

## F4.2 DPDP controls final pass

**Story:** As legal/security, I want the final DPDP posture: consent captured correctly, retention enforced, PII gated.

**AC**
- [ ] Consent-capture pass on registration (F1.1) audited: every submit writes a `consent_ledger` row (P-20.2)
- [ ] Retention enforced: purge jobs (P-20.3) active, tested
- [ ] Participant detail (F3.3) requires a policy check hook (`PIIAccessPolicy.canView`) — default always-allow, but the hook exists for post-MVP tightening
- [ ] Every audit-logged action verified in a dedicated test: every `@audited` route has a corresponding assertion
- [ ] Legal sign-off checklist attached (deferred items documented)

**Config touched:** `features.yaml: dpdp.{retentionDays, piiMaskInParticipantList}`.

**Interfaces touched:** `AuditLog`, `ConsentLedger`, `PIIAccessPolicy` (new interface).

**Tasks**
- [ ] T-4.2.1 Consent-capture audit
- [ ] T-4.2.2 Retention-job verification
- [ ] T-4.2.3 `PIIAccessPolicy` interface + default impl
- [ ] T-4.2.4 Audit-coverage test
- [ ] T-4.2.5 Legal checklist doc

**Blocked by:** P-20 (all), F1.2, F3.3, F3.5

---

## F4.3 WCAG 2.1 AA audit + fixes

**Story:** As a product team, I want every MVP surface to meet WCAG 2.1 AA.

**AC**
- [ ] axe-core runs in CI against every page via Playwright; zero serious/critical issues
- [ ] Manual keyboard-only pass on the four flows (registration, login, onboard, blue dots)
- [ ] Screen-reader spot-check on the dynamic form (P-17.5) + the participant drawer (F3.3)
- [ ] Contrast verified ≥ 4.5:1 on all text

**Tasks**
- [ ] T-4.3.1 axe-core CI job
- [ ] T-4.3.2 Keyboard-only test script + manual pass
- [ ] T-4.3.3 Screen-reader walkthrough
- [ ] T-4.3.4 Fix any findings (each tracked as sub-issue)

**Blocked by:** all UI features

---

## F4.4 Beta rollout playbook + feature flag wiring

**Story:** As ops, I want a staged rollout using feature flags so we can open beta to a subset of aggregators.

**AC**
- [ ] `features.yaml: beta.enabledAggregators` — list of `aggregator_id`s that see beta-only surfaces
- [ ] Beta gate middleware at the route layer (returns 404 for non-beta aggregators)
- [ ] Playbook doc: `docs/ops/beta-rollout.md` — pre-flight checklist, rollout order, rollback steps
- [ ] Rollback drill executed + documented

**Config touched:** `features.yaml: beta.*`.

**Tasks**
- [ ] T-4.4.1 Beta list + middleware
- [ ] T-4.4.2 Playbook doc
- [ ] T-4.4.3 Rollback drill

**Blocked by:** P-03, P-13

---

## F4.5 Load/chaos tests on SPS refresh

**Story:** As the team, I want to know the system behaves gracefully when SPS is slow or stale.

**AC**
- [ ] Test injects: SPS 5xx for 2 min, SPS latency +2 s, SPS freshness > 30 min
- [ ] Aggregator API continues to serve cached summaries (staleness-tolerant) and returns typed errors where no cache
- [ ] UI degrades cleanly (banner: "data as of <time>")
- [ ] Results recorded; no data corruption

**Tasks**
- [ ] T-4.5.1 Chaos harness (toxiproxy or fault-injection middleware)
- [ ] T-4.5.2 Cached-summary fallback verification
- [ ] T-4.5.3 Stale-banner UI
- [ ] T-4.5.4 Report doc

**Blocked by:** P-08, P-12, P-13.5

---

## F4.6 Runbook + on-call docs

**Story:** As on-call, I want a runbook covering the common incidents so I can resolve them without paging the dev team.

**AC**
- [ ] `docs/ops/runbook.md` covers:
  - Upstream Signals/Jobs 5xx spike (circuit-breaker state, how to read)
  - SPS refresh failure (escalation path — external team)
  - DLQ depth > 10 (drain procedure)
  - OTP delivery failure (provider cutover)
  - Export job stuck (manual cancel + cleanup)
  - Database failover
- [ ] Linked from dashboards (P-13.5)
- [ ] GameDay run: dry-run each scenario; fix gaps

**Tasks**
- [ ] T-4.6.1 Runbook authored
- [ ] T-4.6.2 Dashboard→runbook links
- [ ] T-4.6.3 GameDay session + fixes

**Blocked by:** P-13.5
