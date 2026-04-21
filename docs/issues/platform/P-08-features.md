# P-08 signal-processing-client package — features

---

## F-08.1 `SignalProcessingClient` interface + DTOs

**AC**
- [ ] Abstract class with `getOnboardSummary`, `getBlueDotsSummary`, `listParticipants`, `getParticipant`
- [ ] DTOs: `AggregatorOnboardSummary`, `AggregatorBlueDotsSummary`, `ParticipantRow`, `ParticipantDetail`, status enums (`SeekerStatus`, `ProviderStatus`, `ProfileStatus`)
- [ ] Filter/search/paging types reuse `shared-primitives`
- [ ] All methods return `Result<T, UpstreamError>`

**Tasks**
- [ ] T-08.1.1 Interface + DTOs
- [ ] T-08.1.2 Status enums

---

## F-08.2 Summary endpoint bindings

**AC**
- [ ] `getOnboardSummary(aggregatorId)`: registered / verified / discoverable counts, mode-wise counts, flagged counts
- [ ] `getBlueDotsSummary(aggregatorId)`: status-bucket counts + participation metrics + new-in-7-days

**Tasks**
- [ ] T-08.2.1 Onboard summary
- [ ] T-08.2.2 Blue-dots summary

---

## F-08.3 Participants list binding (pagination, filters, search)

**AC**
- [ ] `listParticipants(aggregatorId, { filter, search, paging, sort })` → `Paginated<ParticipantRow>`
- [ ] Filter shape schema-validated; unknown filters rejected

**Tasks**
- [ ] T-08.3.1 Endpoint impl
- [ ] T-08.3.2 Filter schema

---

## F-08.4 Participant detail binding

**AC**
- [ ] `getParticipant(aggregatorId, userId)` → `ParticipantDetail`
- [ ] Response is PII-containing; caller (API) is responsible for audit logging (enforced at consumer, not here)

**Tasks**
- [ ] T-08.4.1 Endpoint impl
