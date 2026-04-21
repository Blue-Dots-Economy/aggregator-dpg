# P-16 Signal Processing Service — contract stub (external)

> SPS is out of scope for this repo (README §5.2). These stub items cover only the contract the Aggregator DPG consumes and the local fake used for development.

---

## S-16.1 Document SPS read-API contract

**AC**
- [ ] `docs/contracts/signal-processing-api.md` documents every endpoint consumed by `signal-processing-client` (P-08): method, path, query params, pagination, response shape, error shapes
- [ ] Aligned with README §5.2 endpoint sketch:
  - `GET /v1/aggregators/:id/onboard-summary`
  - `GET /v1/aggregators/:id/blue-dots-summary`
  - `GET /v1/aggregators/:id/participants`
  - `GET /v1/aggregators/:id/participants/:userId`
- [ ] OpenAPI YAML version checked in (`contracts/signal-processing.openapi.yaml`)

**Tasks**
- [ ] T-16.1.1 Markdown contract doc
- [ ] T-16.1.2 OpenAPI YAML

---

## S-16.2 Local fake with fixture data

**AC**
- [ ] `signal-processing-client/testing` returns deterministic fixture data satisfying the contract
- [ ] Fixtures cover: seekers in every status bucket, providers in every status bucket, mode-wise counts, flagged profiles, multiple aggregators
- [ ] Fixtures versioned alongside the OpenAPI

**Tasks**
- [ ] T-16.2.1 Fixture set
- [ ] T-16.2.2 Fake impl

---

## S-16.3 Contract tests in Aggregator repo

**AC**
- [ ] Test suite validates any impl (fake now; real SPS later) against the OpenAPI
- [ ] Runs in CI against the fake
- [ ] Staging config allows re-pointing at a real SPS with no code change
- [ ] Open items (PRD #1, #3, #4, #6) linked from the contract doc

**Tasks**
- [ ] T-16.3.1 Contract test harness
- [ ] T-16.3.2 Staging configuration
- [ ] T-16.3.3 Linked tracking issues for open items
