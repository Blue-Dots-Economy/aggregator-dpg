# Blue Dots Portal — Frontend Design Spec

**Date:** 2026-04-27
**Author:** Abhishek Gaddi
**Status:** Approved (pending user review of this document)
**Source design:** `/Users/ASUS/Downloads/Aggregator DPG/` — `Blue Dots Portal.html` + `src/*.jsx` + screenshots

## 1. Goal

Port the Blue Dots Aggregator Portal mockup (HTML + Babel-compiled JSX) into a production React + TypeScript application that lives inside the `aggregator-dpg` monorepo at `apps/portal`. The output replaces the static prototype with a maintainable, type-safe, test-covered codebase whose data layer is abstracted behind a service interface so the UI can later be wired to the real `apps/api` backend without touching screens.

## 2. Non-goals

- Backend integration (mock data only in this iteration).
- Real authentication (boolean session flag mirrors source behaviour).
- The Tweaks panel (`tweaks-panel.jsx`) — dev-time customizer, not production.
- Visual redesign — this is a 1:1 port of the existing aesthetic.
- i18n / accessibility audit beyond what the source already provides.
- Replacement of the existing `apps/web` stub.

## 3. Stack

| Concern           | Choice                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Build tool        | Vite 5 + `@vitejs/plugin-react`                                                                 |
| Runtime           | React 18                                                                                        |
| Language          | TypeScript (strict, repo `@aggregator-dpg/tsconfig`)                                            |
| Styling           | Tailwind v3 + PostCSS + Autoprefixer                                                            |
| Routing           | React Router v6 (data router, `createBrowserRouter`)                                            |
| Data fetching     | TanStack Query v5 (React Query)                                                                 |
| State (auth)      | React Context                                                                                   |
| Class composition | `clsx`                                                                                          |
| Testing           | Vitest + `@testing-library/react` + `@testing-library/jest-dom` + `@testing-library/user-event` |
| Linting           | Repo root ESLint + Prettier configs                                                             |

CDN scripts in the source HTML (React, Babel, Tailwind CDN) are dropped — Vite handles bundling.

## 4. Workspace integration

- New package: `apps/portal/` named `@aggregator-dpg/portal` (`private: true`).
- `pnpm-workspace.yaml` already globs `apps/*`; no edits needed.
- Scripts in `apps/portal/package.json`:
  - `dev` → `vite`
  - `build` → `tsc -b && vite build`
  - `preview` → `vite preview`
  - `lint` → `eslint --no-warn-ignored .`
  - `typecheck` → `tsc --noEmit`
  - `test` → `vitest run`
  - `test:watch` → `vitest`
  - `test:coverage` → `vitest run --coverage`
- Inherits root configs: `eslint.config.js`, `prettier.config.js`, `commitlint.config.js`.
- Turbo picks up the package via existing globs in `turbo.json` — verify and add filters only if missing.
- `apps/web` stub is left untouched.

## 5. Folder structure

```
apps/portal/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.cjs
├── .gitignore
├── public/
│   └── favicon.svg
└── src/
    ├── main.tsx                  # ReactDOM root + QueryClient + Router
    ├── App.tsx                   # Routes + AuthProvider
    ├── index.css                 # Tailwind directives + :root tokens from source
    ├── routes/
    │   ├── login.tsx
    │   ├── blue-dots.tsx
    │   ├── onboarding.tsx
    │   ├── profile.tsx
    │   └── protected.tsx         # <ProtectedRoute>
    ├── components/
    │   ├── shell/
    │   │   ├── Sidebar.tsx
    │   │   ├── Topbar.tsx
    │   │   └── ShellLayout.tsx   # Outlet wrapper for guarded routes
    │   └── ui/
    │       ├── Button.tsx
    │       ├── Input.tsx
    │       ├── Label.tsx
    │       ├── Card.tsx
    │       ├── Table.tsx
    │       ├── SegmentedTabs.tsx
    │       ├── StatusPill.tsx
    │       ├── Dropzone.tsx
    │       └── QrCode.tsx        # CSS-only QR placeholder from source
    ├── icons/
    │   └── index.tsx             # typed SVG components, port of icons.jsx
    ├── data/
    │   └── mock.ts               # typed port of data.jsx
    ├── services/
    │   ├── auth.service.ts
    │   ├── blue-dots.service.ts
    │   ├── onboarding.service.ts
    │   └── profile.service.ts
    ├── hooks/
    │   ├── useAuth.ts
    │   ├── useBlueDots.ts
    │   ├── useOnboarding.ts
    │   └── useProfile.ts
    ├── types/
    │   └── index.ts              # BlueDot, Member, Profile, etc.
    ├── lib/
    │   ├── auth-context.tsx
    │   ├── query-client.ts
    │   └── cn.ts
    └── __tests__/
        ├── routes/
        │   ├── login.test.tsx
        │   ├── blue-dots.test.tsx
        │   ├── onboarding.test.tsx
        │   └── profile.test.tsx
        ├── services/
        │   ├── auth.service.test.ts
        │   ├── blue-dots.service.test.ts
        │   ├── onboarding.service.test.ts
        │   └── profile.service.test.ts
        └── components/
            ├── Sidebar.test.tsx
            └── ProtectedRoute.test.tsx
```

## 6. Routing + auth flow

| Path          | Element              | Guard                                   |
| ------------- | -------------------- | --------------------------------------- |
| `/`           | redirect             | `→ /blue-dots` if authed, else `/login` |
| `/login`      | `<LoginScreen>`      | public                                  |
| `/blue-dots`  | `<BlueDotsScreen>`   | `<ProtectedRoute>`                      |
| `/onboarding` | `<OnboardingScreen>` | `<ProtectedRoute>`                      |
| `/profile`    | `<ProfileScreen>`    | `<ProtectedRoute>`                      |
| `*`           | redirect to `/`      | —                                       |

`<ProtectedRoute>` reads `useAuth()`. Unauthenticated → `<Navigate to="/login" replace />`. Authenticated → `<ShellLayout>` (sidebar + main area + `<Outlet />`). Sidebar uses `<NavLink>` with `isActive` callback for the `nav-active` highlight — replaces the `screen` state in `app.jsx`.

`AuthContext` exposes `{ user: User | null, signIn(): void, signOut(): void }`. `signIn()` toggles a boolean (matches source); future swap with `auth.service.ts.login()` returning a session token.

## 7. Service layer

Each service has an interface + mock implementation. The exported binding is a const so the UI imports a single symbol. The swap to HTTP later is a one-line change in the service module.

```typescript
// services/blue-dots.service.ts
import type { BlueDot, BlueDotFilter } from '../types';

export interface BlueDotsService {
  list(filter?: BlueDotFilter): Promise<BlueDot[]>;
  get(id: string): Promise<BlueDot | null>;
}

class MockBlueDotsService implements BlueDotsService {
  async list(filter?: BlueDotFilter): Promise<BlueDot[]> {
    /* read mock.ts, apply filter */
  }
  async get(id: string): Promise<BlueDot | null> {
    /* … */
  }
}

export const blueDotsService: BlueDotsService = new MockBlueDotsService();
```

Hooks wrap services with React Query:

```typescript
// hooks/useBlueDots.ts
export function useBlueDots(filter?: BlueDotFilter) {
  return useQuery({
    queryKey: ['blue-dots', filter],
    queryFn: () => blueDotsService.list(filter),
  });
}
```

Loading and error UI live in screens, not in services.

## 8. Theming

The source HTML defines design tokens as CSS custom properties on `:root`. These move verbatim into `src/index.css` so existing `.bd-*` utility classes keep working:

```css
:root {
  --bd-primary: #4f46e5;
  --bd-primary-600: #4338ca;
  --bd-primary-500: #6366f1;
  --bd-primary-100: #e0e7ff;
  --bd-primary-50: #eef2ff;
  --bd-brand: #10b981;
  --bd-brand-dark: #059669;
  --bd-brand-50: #ecfdf5;
  --bd-bg: #f7f8fb;
  --bd-card: #ffffff;
  --bd-border: #e8eaf1;
  --bd-border-soft: #f0f2f8;
}
```

`tailwind.config.ts` ports the source `tailwind.config` block:

```typescript
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        ink: {
          50: '#F4F6FB',
          100: '#E5E8F2',
          200: '#C5CADD',
          300: '#9098B5',
          400: '#6B7493',
          500: '#475069',
          600: '#2A3350',
          700: '#1E263F',
          800: '#141A2E',
          900: '#0B1020',
        },
      },
    },
  },
  plugins: [],
};
```

Source style block (`.bd-card`, `.bd-shadow`, `.bd-table`, `.bd-input`, `.seg`, `.qr-pattern`, `.dropzone`, `.pulse-dot`, etc.) moves into `index.css` under `@layer components`. Fonts load via `<link>` tags in `index.html`. Tweaks panel and `tweaks-on` data-attribute logic are removed.

## 9. Type system

Inferred from `src/data.jsx`. Three entity collections: seekers, providers, opportunity providers. They share a common shape with one diverging field (`role` exists on providers and opportunity providers only).

```typescript
// types/index.ts
export type ParticipantStatus = 'active' | 'satisfied' | 'at-risk' | 'inactive';

export interface ParticipantStats {
  total: number;
  shortlisted?: number;
  accepted?: number;
  rejected: number;
  pending: number;
}

export interface ParticipantProfile {
  title: string;
  exp: string;
  verified: boolean;
  complete: number; // 0–100
}

export interface ParticipantBase {
  id: string;
  name: string;
  city: string;
  joined: string; // human-formatted date string from source mock
  avatar: string; // initials, e.g. 'PH'
  profile: ParticipantProfile;
  applied: ParticipantStats;
  pre: ParticipantStats;
  status: ParticipantStatus;
  last: string; // human-formatted last-seen string
}

export type Seeker = ParticipantBase;

export interface Provider extends ParticipantBase {
  role: string; // 'Store Manager · 12 openings'
}

export type OpportunityProvider = Provider;

export type ParticipantKind = 'seeker' | 'provider' | 'opportunity-provider';

export interface ParticipantFilter {
  kind?: ParticipantKind;
  status?: ParticipantStatus;
  city?: string;
  search?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
}
```

Zod schemas are not introduced in the portal package — the service layer is the only abstraction this iteration needs. Payload validation belongs at the HTTP boundary, which does not yet exist; introducing it here would be premature.

## 10. Testing strategy

Goal: **≥ 70% line coverage**, matching the repo rule.

| Test type      | Targets                                                                              | Tool             |
| -------------- | ------------------------------------------------------------------------------------ | ---------------- |
| Smoke          | Each route renders without throwing under `<MemoryRouter>` + `<QueryClientProvider>` | RTL              |
| Service unit   | Each mock service method — happy path, empty result, filter                          | Vitest           |
| Component unit | `Sidebar` active-link logic, `ProtectedRoute` redirect, `SegmentedTabs` selection    | RTL + user-event |
| Interaction    | Login submit → navigates to `/blue-dots`; sign-out → navigates to `/login`           | RTL + user-event |

`src/__tests__/setup.ts` extends `expect` with `@testing-library/jest-dom` and provides a `renderWithProviders` helper.

No real network, no real timers, no real DOM portals.

## 11. Edge cases

| Scenario                                | Expected behaviour                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| User hits `/blue-dots` while signed out | Redirect to `/login`                                                                                 |
| User hits `/login` while signed in      | Redirect to `/blue-dots`                                                                             |
| `blueDotsService.list()` returns `[]`   | Render empty state (matches source empty UI; if source has none, render minimal "No items yet" card) |
| React Query in `pending` state          | Render skeleton placeholders that mimic the source row count                                         |
| React Query in `error` state            | Render inline error card with retry button                                                           |
| Unknown route                           | Redirect to `/`                                                                                      |
| `useAuth()` called outside provider     | Throw with descriptive message                                                                       |

## 12. Performance + a11y baseline

- Route-level code splitting via `React.lazy()` for `/onboarding` and `/profile` (kept eager for `/login` and `/blue-dots`).
- `<title>` per route via `document.title` updates in route effects.
- Buttons keep `type="button"` unless inside a `<form>`.
- All interactive icons have `aria-label`.
- Tab order follows visual order — verified manually in browser per route.

## 13. Build, lint, CI

- Repo CI already runs `pnpm -w lint`, `pnpm -w typecheck`, `pnpm -w test`. The new package is picked up automatically.
- `apps/portal/Dockerfile` is **not** part of this iteration — left as a follow-up once a backend wire-up needs an image.
- `vite build` outputs to `apps/portal/dist/`. `dist/` is added to `.gitignore`.

## 14. Acceptance criteria

1. `pnpm install` at repo root completes cleanly.
2. `pnpm --filter @aggregator-dpg/portal dev` starts on a free port (default `5173`); the four screens render and are reachable via sidebar links.
3. `pnpm --filter @aggregator-dpg/portal build` completes with no TypeScript errors.
4. `pnpm --filter @aggregator-dpg/portal lint` passes.
5. `pnpm --filter @aggregator-dpg/portal typecheck` passes.
6. `pnpm --filter @aggregator-dpg/portal test --coverage` passes with ≥ 70% line coverage.
7. Visual fidelity to `Blue Dots Portal.html` is ≥ 95% on the four screens at 1440 px width (manual side-by-side check).
8. Sidebar active-link state, login → dashboard navigation, and sign-out flow work end-to-end.
9. Swapping a service implementation requires changing only the exported binding line in the corresponding `services/*.service.ts` file (no UI edits).

## 15. Open follow-ups (not in scope)

- Wire `auth.service.ts` to the real `apps/api` once OTP endpoints exist (tracked under EPIC P-05).
- Add Storybook for component review.
- Add Playwright E2E once the portal has more than one critical user journey.
- Decide whether to retire `apps/web` after this lands.
