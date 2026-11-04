# Implementation: multi-domain coordinators (#890)

Builds on [multi-domain-coordinator-890.md](multi-domain-coordinator-890.md). aggregator-dpg only; no migration, no Signals change.

## Decisions

| Topic          | Decision                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| Domain checks  | Read the coordinator's domains (`users.serves`) from the database; empty means every domain                 |
| Keycloak token | Still written at registration (first domain); nothing gates on it                                           |
| Registration   | Coordinator picks one or more domains                                                                       |
| Dashboard      | Dropdown, shown only with more than one domain; opens on the first served domain                            |
| Delivery       | Two PRs: backend (Phase 1, Phase 2 API tasks) into `feature`, then web (Phase 2 form tasks, Phase 3) on top |

## Phase 1: API checks and profile

Commit: `feat(api): check coordinator domains from the database (#890)`. After this phase an admin who adds a domain in the console sees it accepted at once.

| Task                                                                                                            | Files                                                       | Tests                                                              |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Helper: served domains of a coordinator (`serves`, or every network domain when empty) and an "is served" check | new `apps/api/src/services/served-domains.ts`               | unit: empty list, one domain, two domains, unknown domain          |
| Replace the token check with the helper on bulk template, bulk create and link create                           | `routes/bulk-uploads.ts`, `routes/registration-links.ts`    | update MISSING/MISMATCH cases; add "second served domain accepted" |
| New error `DOMAIN_NOT_SERVED` (403); remove `AGGREGATOR_TYPE_MISMATCH` and `AGGREGATOR_TYPE_MISSING`            | `errors/codes.ts`                                           | codes test                                                         |
| Dashboard, export, profile export: default to the first served domain; refuse a domain not served               | `routes/dashboard.ts`                                       | default-domain cases; not-served domain returns 403                |
| Login backfill sends every served domain to Signals                                                             | `services/auth/access-token.ts`                             | multi-domain coordinator sends both                                |
| Stop reading the token value into the auth context                                                              | `services/auth/access-token.ts`                             | claim-parsing tests                                                |
| `GET /v1/aggregators/profile/me` returns `serves`; `type` kept                                                  | `routes/aggregator-profile.ts`                              | response shape                                                     |
| Approval page shows every domain                                                                                | `routes/aggregator-approvals.ts`, `views/approval-pages.ts` | page render                                                        |
| Regenerate the OpenAPI spec                                                                                     | `pnpm --filter @aggregator-dpg/api spec:dump`               | CI spec-drift check                                                |

## Phase 2: registration with several domains

Commit: `feat(registration): let a coordinator pick several domains (#890)`.

| Task                                                                        | Files                                                                                                                                                             | Tests                                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Payload `type` accepts one domain or a non-empty list; normalised to a list | `packages/shared-primitives/src/aggregator/index.ts`                                                                                                              | string and list accepted; empty list and duplicates refused |
| Validate every domain id against the network                                | `services/registration-validator.ts`, `routes/aggregator-registrations.ts`                                                                                        | unknown id in the list refused                              |
| Store the full list; Keycloak attribute gets the first domain               | `routes/aggregator-registrations.ts`, `services/user-store/{interface,postgres,memory}.ts` (create input gains `serves`)                                          | stored `serves`; attribute value                            |
| Form field becomes a multi-select checkbox list                             | `registration.v1.json` + `.ui.json` in `config/schemas/aggregator`, `blue_dot/ka-dhwd`, `blue_dot/up-gzb`, `orange_dot`, `orange_dot/onetac`, `purple_dot/alimco` | schema loads for every network                              |
| Network domain patch fills the list's choices                               | `apps/web/src/lib/aggregator-schema.server.ts`                                                                                                                    | patch test for the array field                              |
| `/profile` shows the list, or "All domains" when empty                      | `apps/web/src/app/(protected)/profile/ProfileFormView.tsx`                                                                                                        | render test                                                 |

The first three tasks ship in the backend PR; the form, schema patch and `/profile` tasks ship in the web PR. An old single-choice schema copy keeps working, since the API still accepts one domain.

## Phase 3: web portal

Commit: `feat(web): domain dropdown and selectors for multi-domain coordinators (#890)`.

| Task                                                                                                      | Files                                                                        | Tests                                         |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| Profile client reads `serves`                                                                             | `services/profile.service.ts`                                                | service test                                  |
| Active-domain hook: URL `?domain=`, then last choice, then first served; always one of the served domains | new `hooks/useActiveDomain.ts`                                               | each fallback; invalid URL value ignored      |
| Dashboard dropdown in the top bar; changing domain resets page, filter and selection                      | `app/(protected)/dashboard/page.tsx`                                         | replace "no tab strip" test; switch test      |
| Fix the loading-screen hang for "all domains" coordinators                                                | `app/(protected)/dashboard/page.tsx`                                         | empty `serves` renders                        |
| Sidebar badge follows the active domain                                                                   | `components/shell/Sidebar.tsx`                                               | badge test                                    |
| Link creation: domain selector, defaults to the active domain; link list shows every served domain        | `onboarding/_components/RegistrationLinksSection.tsx`, `onboarding/page.tsx` | replace read-only field test                  |
| Bulk upload: domain selector drives template download and upload                                          | `onboarding/_components/CSVUpload.tsx`                                       | replace read-only chip and template URL tests |
| Console: confirm before removing a domain from a coordinator                                              | `components/console/CoordinatorActions.tsx`                                  | confirm shown on removal only                 |
| Copy for the dropdown, selectors and confirmation in en, hi, kn                                           | `apps/web/src/i18n/messages`                                                 | catalogue key test                            |

## Verification

| Check                   | How                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests and coverage | `pnpm -w test`, at least 70% lines for changed packages                                                                                                             |
| Build gates             | `pnpm -w typecheck`, `pnpm -w lint`, `pnpm dep-check`, spec drift                                                                                                   |
| End to end              | `aggregator-e2e` skill: register a coordinator with both domains, approve, upload a CSV and create a link for each domain, switch the dashboard, export each domain |
| Negative case           | Coordinator serving seeker only gets 403 `DOMAIN_NOT_SERVED` on a provider upload or link                                                                           |
| Existing coordinators   | Single-domain coordinator sees no dropdown and the same screens as before                                                                                           |

## Rollout

1. Deploy the API before the web app. The web app reads `serves`; the API still returns `type` for an older web build.
2. No migration or backfill. Existing coordinators keep their stored domains.
3. Before release, check whether either Signals default org is linked to an aggregator-dpg coordinator. If one is, keep every domain on that coordinator.
4. Tell the campaign-manager owners the token value is unchanged.
