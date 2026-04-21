# P-17 Frontend Foundation — features

---

## F-17.1 Next.js scaffold (`apps/web`)

**AC**
- [ ] Next.js App Router, TypeScript
- [ ] `pnpm --filter web dev` runs; `/` renders a placeholder
- [ ] Shared tsconfig from P-01.2

**Tasks**
- [ ] T-17.1.1 Scaffold
- [ ] T-17.1.2 Dockerfile integration

---

## F-17.2 UI library + design tokens

**AC**
- [ ] Radix UI primitives + Tailwind CSS
- [ ] Design tokens exported in `packages/ui` (colors, spacing, typography)
- [ ] Storybook (optional) for primitive visual review

**Tasks**
- [ ] T-17.2.1 Install Radix + Tailwind
- [ ] T-17.2.2 Token package
- [ ] T-17.2.3 Storybook (opt)

---

## F-17.3 TanStack Query + typed API client

**AC**
- [ ] TanStack Query provider in app root
- [ ] API client generated from `apps/api` OpenAPI via `openapi-typescript` + thin wrapper
- [ ] Shared error mapping: upstream errors surface typed client errors

**Tasks**
- [ ] T-17.3.1 Query provider
- [ ] T-17.3.2 API types generation
- [ ] T-17.3.3 Error mapper

---

## F-17.4 Auth context + protected routes

**AC**
- [ ] Auth context exposes `session`, `login(otp)`, `logout`
- [ ] Protected layouts redirect to `/login` when no session
- [ ] Session kept in memory + httpOnly cookie for refresh (or equivalent secure scheme; decided with P-05)

**Tasks**
- [ ] T-17.4.1 Context + hooks
- [ ] T-17.4.2 Protected layout
- [ ] T-17.4.3 Refresh flow

---

## F-17.5 Schema-driven form renderer

**AC**
- [ ] Component consumes the descriptor from `schema-service` (via API) and renders all field types listed in PRD Profile schema
- [ ] Required-field validation client-side; server-side authoritative
- [ ] A11y: every field has a label, error messages associated via `aria-describedby`

**Tasks**
- [ ] T-17.5.1 Renderer skeleton
- [ ] T-17.5.2 Field type implementations (text, number, select, multi-select, date, phone, email)
- [ ] T-17.5.3 Validation + submit

---

## F-17.6 Table/list primitive

**AC**
- [ ] Pagination, sort, filter, search as props; backend-driven state
- [ ] Keyboard-navigable; sort controls accessible

**Tasks**
- [ ] T-17.6.1 Table component
- [ ] T-17.6.2 Integration with TanStack Query pagination helpers

---

## F-17.7 i18n (next-intl)

**AC**
- [ ] next-intl wired; `en` bundle present; `hi` empty placeholder
- [ ] All UI strings from Phase 1+ come from bundles

**Tasks**
- [ ] T-17.7.1 next-intl setup
- [ ] T-17.7.2 Locale switcher (defers to `features.yaml` available locales)

---

## F-17.8 A11y primitives + lint

**AC**
- [ ] `eslint-plugin-jsx-a11y` recommended rules enabled
- [ ] CI runs `axe-core` (via Playwright) against sample pages; violations block PR

**Tasks**
- [ ] T-17.8.1 ESLint rules
- [ ] T-17.8.2 axe-core Playwright integration
