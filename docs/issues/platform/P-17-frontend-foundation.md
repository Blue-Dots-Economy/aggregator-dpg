---
name: Epic
about: P-17 Frontend Foundation
title: "[EPIC] P-17 Frontend Foundation"
labels: ["type:epic", "phase:0", "area:frontend", "priority:p0"]
milestone: "Phase 0 — Foundations"
---

## Summary
`apps/web` scaffolding: Next.js App Router, UI library (Radix + Tailwind recommended) with design tokens, TanStack Query with a typed API client generated from the BFF's OpenAPI, auth context + protected routes, schema-driven form renderer that consumes the descriptor from `schema-service`, table/list primitive, i18n via next-intl, and a11y primitives + eslint rules.

## Scope
**In scope:** Next.js scaffold; UI lib + tokens; TanStack Query setup; typed API client; auth context; schema-driven form; table primitive; i18n; a11y lint rules.
**Out of scope:** Any feature page (lives in Φ1 … Φ3).

## Child features
- [ ] F-17.1 Next.js scaffold (`apps/web`)
- [ ] F-17.2 UI library + design tokens
- [ ] F-17.3 TanStack Query + typed API client
- [ ] F-17.4 Auth context + protected routes
- [ ] F-17.5 Schema-driven form renderer
- [ ] F-17.6 Table/list primitive (pagination, sort, filter, search)
- [ ] F-17.7 i18n (next-intl)
- [ ] F-17.8 A11y primitives + `eslint-plugin-jsx-a11y`

## Success criteria
- A new page built on these primitives requires no custom form/table code
- `pnpm --filter web typecheck && lint && test` green in CI

## Dependencies
- **Platform:** P-01, P-02, P-03, P-13, P-14

## Labels / milestone
- Labels: `type:epic`, `phase:0`, `area:frontend`, `priority:p0`
- Milestone: `Phase 0 — Foundations`
