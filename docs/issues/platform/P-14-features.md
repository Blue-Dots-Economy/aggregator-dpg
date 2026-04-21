# P-14 schema-service package — features

---

## F-14.1 Profile schema versioning

**AC**
- [ ] Interface: `getActiveVersion(aggregatorId)`, `listVersions(aggregatorId)`, `publishVersion(aggregatorId, schema)`, `diff(vA, vB)`
- [ ] Versions persisted in `aggregator_profile_schema` (P-04.4.1)
- [ ] Default impl reads active version from DB; initial seed from `profiles.yaml`

**Tasks**
- [ ] T-14.1.1 Interface
- [ ] T-14.1.2 Default impl
- [ ] T-14.1.3 Diff algorithm (added/removed/changed fields)

---

## F-14.2 Dynamic form descriptor emitter

**AC**
- [ ] `emitFormDescriptor(version)` returns a JSON-serialisable descriptor the frontend renders (groups, fields, type, required, options, help text)
- [ ] Descriptor stable for a given version (hash in response)

**Tasks**
- [ ] T-14.2.1 Emitter
- [ ] T-14.2.2 Stable hash

---

## F-14.3 Completion-% calculator

**AC**
- [ ] `computeCompletionPct(schemaVersion, values)` = filled required fields ÷ total required fields
- [ ] Same function consumed by API (for flagged-profile classification) and by the frontend (for display)
- [ ] Round to nearest integer; threshold default 75% (configurable via `profiles.yaml`)

**Tasks**
- [ ] T-14.3.1 Calculator
- [ ] T-14.3.2 Shared consumption (exported from `./interface`)

---

## F-14.4 Config-driven required/optional resolution

**AC**
- [ ] Per-field `required` flag honoured
- [ ] Group-level overrides supported (e.g., in PwD use case, different required set)
- [ ] Documented in `docs/profiles.md`

**Tasks**
- [ ] T-14.4.1 Resolver
- [ ] T-14.4.2 Doc
