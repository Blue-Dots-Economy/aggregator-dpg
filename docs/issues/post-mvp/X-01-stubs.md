# X-01 Post-MVP Backlog — stub features

> Each H2 below is a deferred feature. Labels: `type:feature`, `phase:post-mvp`, `priority:p2` (and `status:Deferred` in the Project). Bodies intentionally light — they exist to hold the backlog slot, not to spec the work.

---

## AG-0a Self-service registration status tracking

**Story:** As a prospective aggregator admin, I want to check my registration status in the app so I don't depend on email only.

**Scope sketch:** pre-login route `/register/status?token=...` reading from `registration_request`. Needs: secure token delivery in the initial confirmation email (F1.3 extension).

**Blocked by (if pulled in):** F1.2, F1.3

---

## AG-3 In-app connection notifications

**Story:** As an aggregator admin, I want in-app notifications when participants' connection status changes so I can act quickly.

**Scope sketch:** notification store, SPS subscription/delta feed, in-app center, filters by type.

**Upstream dep:** SPS must emit change events (out of scope for MVP — see P-16 stub).

---

## AG-4 Direct outreach from the Aggregator surface

**Story:** As an aggregator admin, I want to send a follow-up message to participants from within the app.

**Scope sketch:** outreach template store, delivery via `EmailService` / SMS provider, opt-out enforcement.

**Legal dep:** PRD open item 2 (PII access legal basis) must be resolved first.

---

## AG-5 Aggregator-of-Aggregators view

**Story:** As a macro aggregator, I want to see aggregated metrics across aggregators I coordinate.

**Scope sketch:** new role `super-aggregator_admin`; nested scoping model; SPS aggregation endpoints at the super level.

**RBAC dep:** FS-6 RBAC tiers must land first.

---

## AG-7 Natural-language queries

**Story:** As an aggregator admin, I want to ask questions in natural language ("which seekers in Bangalore have applied but been rejected in the last 30 days?") and get structured answers.

**Scope sketch:** LLM gateway; schema/vocabulary guardrails; PII handling; answer audit.

**Legal + model governance deps** are significant; explicit deferral.

---

## AG-8 Ad-hoc report generation

**Story:** As an aggregator admin, I want to define custom reports (columns, filters, schedule) beyond the canned CSV.

**Scope sketch:** saved-report definitions, parameterised generation, scheduled delivery via `EmailService`.

**Dep:** builds on F3.5/F3.6; likely overlaps with AG-7 if NL is the UX.

---

## FS-1 Profile-contact write-back to Signals Stack

**Story:** As an aggregator admin, when I update contact details, I want them to propagate upstream so the Signals Stack is the source of truth.

**Scope sketch:** add write endpoints to `SignalStackClient`; reconciliation policy for conflicting upstream edits; idempotency.

**Dep:** Signals Stack write API must exist.

---

## FS-2 Unstructured bulk upload

**Story:** As an aggregator admin, I want to upload a CSV / Excel / PDF with arbitrary column headers and have the system map them to our schema.

**Scope sketch:** heuristic + LLM-assisted mapping UI; human-in-the-loop confirmation; audit of mapping decisions.

---

## FS-3 Credential issuance on bulk create

**Story:** As an aggregator admin, I want newly-created participants to receive verifiable credentials automatically.

**Scope sketch:** integration with credential issuer; key management; revocation.

---

## FS-4 Voice-call onboarding

**Story:** As a low-literacy participant, I want to onboard by voice call.

**Scope sketch:** IVR/voice-bot; transcript + confirmation loop; identity proofing.

---

## FS-5 Lifecycle management

**Story:** As an aggregator admin, I want to mark participants as inactive / archived / graduated and manage their lifecycle.

**Scope sketch:** lifecycle states; policies per state (what's visible where); archival storage.

---

## FS-6 RBAC tiers (coordinator / admin / super-admin)

**Story:** As an aggregator, I want multiple user roles with scoped permissions so coordinators can onboard but not export, etc.

**Scope sketch:** role model; policy middleware generalisation; per-route permission declarations; admin UI for role management.

**Dep:** prerequisite for AG-5 and organisationally for AG-4.

---

## FS-7 (placeholder — PRD Future Scope item 7)

**Story:** TBD — resolve from PRD Future Scope list when prioritised.

---

## FS-8 (placeholder — PRD Future Scope item 8)

**Story:** TBD — resolve from PRD Future Scope list when prioritised.
