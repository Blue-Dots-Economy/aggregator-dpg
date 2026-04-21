---
name: Feature
about: A deliverable feature under an epic (1-2 weeks of work max)
title: "[FEAT] <short title>"
labels: ["type:feature"]
---

## User story / JTBD
As **<role>**, I want **<capability>**, so that **<outcome>**. (JTBD: AG-*, if product)

## Acceptance criteria
- [ ] …
- [ ] …
- [ ] Error/edge case handled: …

## Configuration surface
Which `config/*.yaml` keys (or per-package `config.schema.ts` entries) does this feature introduce or consume?
- `onboarding.yaml: modes.bulk.enabled` (example)

## Interfaces touched
- Interface: `<package>/interface` → `<InterfaceName>`
- Impl subpath: `<package>/<impl>` (if this feature adds/changes impl)

## Tests (mandatory)
- [ ] **Unit** — <services / pure functions>
- [ ] **Integration** — <API routes / DB / upstream>
- [ ] **E2E** (if critical flow) — <Playwright scenario>

## Child tasks
- [ ] #<task>
- [ ] #<task>

## Dependencies
**Blocked by:**
- #<platform-issue>
- #<feature-issue>

## Definition of Done
- [ ] Code + tests merged; coverage gate met
- [ ] Docs updated (README / config reference / `CHANGELOG`)
- [ ] Observability hooks added (logs / metrics / traces)
- [ ] Accessibility (if UI): keyboard + screen-reader verified
- [ ] DPDP: PII access audit-logged where applicable

## Labels / milestone
- Labels: `type:feature`, `phase:<N>`, `area:<primary>`, `jtbd:AG-*` (if product), `priority:p<0|1|2>`
- Milestone: `Phase <N> — <name>`
