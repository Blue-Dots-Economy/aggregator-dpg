# P-07 jobs-stack package — features

---

## F-07.1 `JobsStackClient` interface + DTOs

**AC**
- [ ] Abstract class with: `listPostingsByOrg`, `listApplicationsByUser`, `listApplicationsByOrg`
- [ ] DTOs: `JobPosting`, `JobApplication` with status enum `Open | Shortlisted | Rejected`
- [ ] All methods return `Result<T, UpstreamError>`

**Tasks**
- [ ] T-07.1.1 Interface + DTOs

---

## F-07.2 REST adapter scaffold

**AC**
- [ ] HTTP wrapper mirroring P-06.2 conventions; base URL + endpoints from config

**Tasks**
- [ ] T-07.2.1 Adapter scaffold
- [ ] T-07.2.2 Config wiring

---

## F-07.3 Postings read

**AC**
- [ ] `listPostingsByOrg(orgId)` paginated; each posting includes `metadata.positions`

**Tasks**
- [ ] T-07.3.1 Endpoint impl

---

## F-07.4 Applications read

**AC**
- [ ] `listApplicationsByUser(userId)` and `listApplicationsByOrg(orgId)` paginated
- [ ] Each row includes `updated_at` + `application_status`

**Tasks**
- [ ] T-07.4.1 Endpoint impls

---

## F-07.5 Status mapping

**AC**
- [ ] Upstream status strings mapped to the typed enum exactly once (`toApplicationStatus`)
- [ ] Unknown statuses produce `UpstreamError` rather than silently defaulting

**Tasks**
- [ ] T-07.5.1 Mapping fn + tests

---

## F-07.6 Retry/backoff

**AC**
- [ ] Same retry policy as P-06.7 (minus circuit breaker if not warranted in MVP)

**Tasks**
- [ ] T-07.6.1 Retry wrapper reuse

---

## F-07.7 Contract tests

**AC**
- [ ] Prism mock covers each method; CI gate

**Tasks**
- [ ] T-07.7.1 Contract tests
