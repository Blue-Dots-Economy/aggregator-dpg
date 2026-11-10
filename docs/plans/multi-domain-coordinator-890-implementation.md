# Implementation: multi-domain coordinators (#890)

Builds on [multi-domain-coordinator-890.md](multi-domain-coordinator-890.md). aggregator-dpg only; no migration, no Signals change. The Keycloak `aggregator_type` mapper and user-profile attribute become multivalued (infra PR, and the deployment realm in bluedots-automation).

## Decisions

| Topic          | Decision                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain checks  | Read the profile types from the token's multivalued `aggregator_type` claim, once per session; no database read. Empty means none                         |
| Keycloak token | Every profile type is written at registration and on every console change; a console change ends the coordinator's sessions, so the next login carries it |
| No types       | A coordinator with an empty `serves` is refused everything until an owner sets its types in the console                                                   |
| Registration   | Coordinator picks one or more domains                                                                                                                     |
| Dashboard      | Dropdown, shown only with more than one domain; opens on the first served domain                                                                          |
| Delivery       | Two PRs: backend (Phase 1, Phase 2 API tasks) into `feature`, then web (Phase 2 form tasks, Phase 3) on top                                               |

## Phase 1: API checks and profile

Commit: `feat(api): check coordinator domains from the token claim (#890)`. After this phase an owner who changes a coordinator's types in the console ends its sessions; its next login carries the new types.

| Task                                                                                                                    | Files                                                                | Tests                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Helper: served domains of a coordinator (token types filtered to the network; none when empty) and an "is served" check | `apps/api/src/routes/served-domains-shared.ts`                       | unit: empty list, one domain, two domains, unknown domain                 |
| Replace the token check with the helper on bulk template, bulk create and link create                                   | `routes/bulk-uploads.ts`, `routes/registration-links.ts`             | update MISSING/MISMATCH cases; add "second served domain accepted"        |
| New error `DOMAIN_NOT_SERVED` (403); remove `AGGREGATOR_TYPE_MISMATCH` and `AGGREGATOR_TYPE_MISSING`                    | `errors/codes.ts`                                                    | codes test                                                                |
| Dashboard, export, profile export: default to the first served domain; refuse a domain not served                       | `routes/dashboard.ts`                                                | default-domain cases; not-served domain returns 403                       |
| Login backfill and approval send the served domains to Signals; none sent when it serves none                           | `services/auth/access-token.ts`, `services/decisions/coordinator.ts` | multi-domain coordinator sends both; empty sends none                     |
| Read the multivalued claim into `AuthContext.serves`                                                                    | `services/auth/access-token.ts`                                      | claim-parsing tests                                                       |
| Console change writes the attribute, then Signals, then the row, then ends the sessions                                 | `routes/v1-user.ts`                                                  | attribute written, sessions ended, Keycloak restored on a Signals failure |
| `GET /v1/aggregators/profile/me` returns `serves`; `type` kept                                                          | `routes/aggregator-profile.ts`                                       | response shape                                                            |
| Approval page shows every domain                                                                                        | `routes/aggregator-approvals.ts`, `views/approval-pages.ts`          | page render                                                               |
| Regenerate the OpenAPI spec                                                                                             | `pnpm --filter @aggregator-dpg/api spec:dump`                        | CI spec-drift check                                                       |

## Phase 2: registration with several domains

Commit: `feat(registration): let a coordinator pick several domains (#890)`.

| Task                                                                        | Files                                                                                                                                                             | Tests                                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Payload `type` accepts one domain or a non-empty list; normalised to a list | `packages/shared-primitives/src/aggregator/index.ts`                                                                                                              | string and list accepted; empty list and duplicates refused |
| Validate every domain id against the network                                | `services/registration-validator.ts`, `routes/aggregator-registrations.ts`                                                                                        | unknown id in the list refused                              |
| Store the full list; Keycloak attribute gets every domain                   | `routes/aggregator-registrations.ts`, `services/user-store/{interface,postgres,memory}.ts` (create input gains `serves`)                                          | stored `serves`; attribute value                            |
| Form field becomes a multi-select checkbox list                             | `registration.v1.json` + `.ui.json` in `config/schemas/aggregator`, `blue_dot/ka-dhwd`, `blue_dot/up-gzb`, `orange_dot`, `orange_dot/onetac`, `purple_dot/alimco` | schema loads for every network                              |
| Network domain patch fills the list's choices                               | `apps/web/src/lib/aggregator-schema.server.ts`                                                                                                                    | patch test for the array field                              |
| `/profile` shows the list, or "None" when empty                             | `apps/web/src/app/(protected)/profile/ProfileFormView.tsx`                                                                                                        | render test                                                 |

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
2. No migration or backfill. An existing coordinator's attribute already holds its one registered type. A coordinator with no stored type is locked out until an owner sets its types in the console.
3. Make the `aggregator_type` mapper and user-profile attribute multivalued before the API deploys, here and in the bluedots-automation deployment realm.
4. Before release, check whether either Signals default org is linked to an aggregator-dpg coordinator. If one is, keep every domain on that coordinator.
5. Tell the campaign-manager owners the `aggregator_type` claim can now be a list.
