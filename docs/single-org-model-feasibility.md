# Feasibility: a single organisation that is NF + aggregator + Default

**Status:** exploratory — not planned. Captured for the RBAC discussion (#805 / #849).
**Date:** 2026-10-09.
**Question:** can the network-facilitator (root) organisation also be an aggregator and the Default aggregator — one org that acts as everything?

## Current model (enforced, by design)

- `org_type` is an enum **per row**: `network_facilitator` **or** `aggregator`. A row is exactly one.
- A partial unique index enforces **exactly one** `network_facilitator` (the root, `parent_id` NULL).
- The org store scopes **every** read/write to `org_type = 'aggregator'` (`scoped()`), except `findRoot()` — so the root is deliberately invisible to all aggregator-org operations.
- **Default** is a separate `aggregator` row (`slug = 'default'`) that holds coordinators with no other org.
- Owner lookups (`findByOwnerEmail` / `findByOwnerPhone`) skip Default, so the network admin is not read as an org owner.
- Phase 5 console reach assumes: network admin = owner of the **root**; owners = owners of **aggregator** orgs. Out of reach → 404; wrong actor kind → 403.

"One org = NF + aggregator + Default" collides with the enum (one type per row) and the scoping design. It is a core model change, not a config flag.

## Options

### A — True single row (the root is also the default aggregator)
Coordinators with no other org point at the root; no separate Default row.

| Area | Change | Risk |
| --- | --- | --- |
| Schema / enum | A row must be NF **and** act as aggregator: relax `scoped()` to admit the root when it is the single org, or add a capability flag. The "one NF, everything else aggregator" invariant is rewritten. | High (core) |
| Migration | Collapse root + Default into one row; re-point Default coordinators' `org_id`; move the Keycloak group. Plus the existing-instance path in the instance-upgrade tool. | High |
| Org store | `scoped()`, `findRoot`, `findDefault`, `isDefault`, and the owner-lookup skip (which exists so the admin is *not* seen as an owner — that inverts). | High |
| Phase 5 console | "Owner" and "network admin" collapse into one; the 404/403 reach matrix, search and counts need rework. | Medium-High |
| Boot reconcile | `organisation-root.ts` seeds and owns root + Default as two rows; becomes one. | Medium |
| RBAC (in flight) | #805 / #849 are built on this exact model (root vs aggregator, owner vs network admin). Changing it now invalidates assumptions in `rbac-design-aggregator.md` and `docs/plans/phase-5-rbac-handoff.md`. | High (coordination) |

**Size:** a phase-sized effort (comparable to one of the 0027–0029 migrations), not a patch.
**Payoff:** removes one org row, one Keycloak group, and the "Default" label in a single-org deployment. Operationally modest.

### B — Keep two rows, one operator (current behaviour)
The root NF and the Default aggregator are **both owned by the network admin** (the Default owner defaults to the root owner). One identity already runs everything: that person approves coordinators, and the Default org is the single aggregator everyone joins. No model change. Cost: two bookkeeping rows and the "Default" name showing.

### C — "Single-tenant mode" (config)
A deployment flag: exactly one aggregator (the Default), the root hidden/merged in the UI, coordinators auto-join it. Lighter than A, but still needs care in the store, console and reconcile.

## Verdict

- **Feasible, but net-negative today.** The cost (core invariant + migration + Phase 5 rework + colliding with the in-flight RBAC work) outweighs the gain for a single-org deployment.
- **Option B already delivers the operational outcome:** one operator (the network admin) owns the root and the Default aggregator; the Default org is the single aggregator everyone joins.
- If the only pain is cosmetic (the "Default" label, two rows visible), a **UI-only** change (hide the root, relabel/auto-select Default) is cheap and safe.
- Revisit **A** only on a hard requirement that the NF must onboard coordinators under its own identity (not via a Default bucket) — and fold it into the RBAC phase so the model changes once, not twice.
