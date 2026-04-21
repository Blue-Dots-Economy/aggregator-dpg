# P-19 DevEx & CI — features

---

## F-19.1 Branch protections on `main`

**AC**
- [ ] Required checks: CI lint, typecheck, test, build, depcruise, migration round-trip
- [ ] ≥ 1 approving review; linear history; no force push

**Tasks**
- [ ] T-19.1.1 Apply branch protection rule
- [ ] T-19.1.2 Doc in CONTRIBUTING

---

## F-19.2 PR template + checklist

**AC**
- [ ] `.github/pull_request_template.md` covers: summary, test plan, config changes, observability additions, DPDP impact, linked issue
- [ ] Checkbox for "no PII in logs"

**Tasks**
- [ ] T-19.2.1 Template

---

## F-19.3 CODEOWNERS

**AC**
- [ ] `/packages/db/` → db-leads, `/packages/auth/` → security-leads, `/apps/web/` → frontend-leads, `/ops/` → sre-leads
- [ ] Reviews auto-requested on PR touching owned paths

**Tasks**
- [ ] T-19.3.1 File authored

---

## F-19.4 Preview deploys per PR

**AC**
- [ ] `apps/web` preview via Vercel (or equivalent)
- [ ] Ephemeral `apps/api` preview (Docker + k8s namespace, or Railway/Fly) reachable from the preview web
- [ ] Torn down on PR close

**Tasks**
- [ ] T-19.4.1 Web preview
- [ ] T-19.4.2 API ephemeral env
- [ ] T-19.4.3 Teardown hook

---

## F-19.5 Renovate configuration

**AC**
- [ ] `.github/renovate.json` batches minor/patch weekly, majors quarterly
- [ ] Security alerts auto-open PRs immediately

**Tasks**
- [ ] T-19.5.1 Config
